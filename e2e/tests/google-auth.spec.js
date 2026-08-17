// GA-T4 — 10 §UC-GA-003 (friend Google login) + §UC-GA-005 (the login-card button),
// plus resolved decisions #1 (`must_change_password` is honoured) and #2 (modern mode
// only). §UC-GA-013 obligation 5 names this file.
//
// ⚠ WHAT THIS FILE CANNOT TEST, stated up front (§UC-GA-013, verbatim intent): the GIS
// button flow itself — the cross-origin iframe, Google's popup, credential issuance —
// cannot run against a stub Google in Playwright. THE E2E BOUNDARY IS THE ID TOKEN
// POST. Everything from that POST inward is tested here through the §UC-GA-002 seam
// (`GOOGLE_AUTH_TEST_MODE=1` + `TEST:<sub>:<email>` tokens). Wrong-`aud` / wrong-`iss` /
// expired against REAL Google tokens is delegated to `google-auth-library` and one
// manual staging walkthrough. What IS testable and is pinned here: the endpoint's whole
// contract, and the button's PRESENCE/ABSENCE matrix (configured × auth mode) together
// with the request to `accounts.google.com` that presence implies.
//
// ── Where each half runs, and why ────────────────────────────────────────────────
//
// API: on THROWAWAY BACKENDS (`startBackend`, the magic-link precedent), not on the
// gate. Two reasons, both hard:
//   1. The endpoint is modern-mode only, and `e2e/seed.mjs` pins the shared gate to
//      `auth_mode = 'legacy'` — `modern-login.spec.js` asserts in an `afterAll` that no
//      file wrote it. A throwaway backend can be modern without touching anyone.
//   2. No route CREATES a Google link yet (GA-T5 owns `PUT …/google-link`), so every
//      linked fixture is a direct column write — `friends-consolidation.spec.js`'s
//      precedent. On a throwaway backend that write needs no `DB_PATH` and can never
//      self-skip, so these tests are non-vacuous on any host.
// The gate server still carries ONE API test (the legacy-mode 409) because that is the
// state it is actually in, and it runs against a deployment too.
//
// UI: on the gate, with `page.route` stubs of `GET /friends/auth-mode` — the
// `modern-login.spec.js` rule (never write `auth_mode`).
//
// ⚠ EVERY STUB IN THIS FILE CARRIES AN EXPLICIT `googleClientId`, including the
// absence cases. `friends-consolidation.spec.js:835/946/985/1041` stub
// `{ authMode: 'modern' }` with the key MISSING, so against those stubs the field is
// `undefined` and a "no Google button" assertion passes VACUOUSLY — it would pass
// against a button that ignored the flag entirely. Here `null` is stated, and the
// positive control (same card, same stub shape, an id present ⇒ the button DOES render
// and DOES request `accounts.google.com`) sits in the same describe so the pair can
// only both pass if the flag is really the gate.

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAN_SPAWN_BACKEND, startBackend } from '../mailgun-harness.js'

const NEEDS_SOURCE = 'needs the backend source beside e2e/ (skipped against a deployment)'

// The exact bytes §UC-GA-003 / §UC-GA-002 / resolved decision #2 mandate. Asserted as
// literals: the whole point of the 401-vs-503-vs-409 split is that the three never read
// as each other, which only exact strings can hold.
const NOT_LINKED_ERROR =
  'Tento Google účet nie je prepojený so žiadnym účtom. Prihláste sa menom a heslom a prepojte ho v profile.'
const GENERIC_401 = 'Nesprávne prihlasovacie údaje'
const LEGACY_409 = 'Prihlásenie cez Google je dostupné až po prechode na osobné prihlasovanie'
const NOT_CONFIGURED = 'Prihlásenie cez Google nie je nakonfigurované'
const BAD_TOKEN = 'Neplatný Google token'

const TEST_CLIENT_ID = 'test-client'
const GOOGLE_ENV = { GOOGLE_CLIENT_ID: TEST_CLIENT_ID, GOOGLE_AUTH_TEST_MODE: '1' }

// ⚠ The strip-rule pin (the UC-IA-005 pattern, inherited by FC-T1 and restated by
// §UC-GA-003). Applied to the RAW RESPONSE TEXT, never to a key list: a future
// `SELECT *` spread would add the column back under its own name and a key assertion
// on the fields we happen to know about would not notice.
const STRIP_RE = /google_sub/

let seq = 0
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const tag = (label) => `${label}-${uniq}-${++seq}`

// ═════════════════════════════════════════════════════════════════════════════
// Throwaway-backend harness
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run `fn` against a freshly seeded throwaway backend.
 *
 * `fn` receives `{ backend, ctx, adminToken, db, api }`. `db` opens the backend's own
 * sqlite file (WAL, so a concurrent reader is safe — the `friends-consolidation.spec.js`
 * precedent) and is the ONLY way to manufacture a Google link until GA-T5 ships one.
 */
async function withGoogleBackend(extraEnv, fn) {
  let backend
  let ctx
  try {
    backend = await startBackend({ ...GOOGLE_ENV, ...extraEnv })
    ctx = await playwrightRequest.newContext({ baseURL: backend.baseUrl })
    const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status(), 'harness admin login (did seed.mjs run?)').toBe(200)
    const adminToken = (await login.json()).token
    await fn({ backend, ctx, adminToken, ...makeApi(ctx, adminToken, backend.dbPath) })
  } finally {
    await ctx?.dispose()
    await backend?.stop()
  }
}

function makeApi(ctx, adminToken, dbPath) {
  const admin = () => ({ 'X-Admin-Token': adminToken })

  function withDb(fn) {
    const db = new DatabaseSync(dbPath)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }

  const api = {
    withDb,
    async setModernMode() {
      const r = await ctx.put('/api/admin/settings', { headers: admin(), data: { authMode: 'modern' } })
      expect(r.status(), 'switch to modern auth mode').toBe(200)
      expect((await r.json()).authMode).toBe('modern')
    },
    /** GA-T6: `transition` is the only mode in which a PERSONAL login (the one that
     *  publishes `googleLinked`/`googlePromptDismissed`) happens OUTSIDE modern mode —
     *  i.e. the only place the §UC-GA-006 `authMode === 'modern'` term is discriminating. */
    async setAuthMode(mode) {
      const r = await ctx.put('/api/admin/settings', { headers: admin(), data: { authMode: mode } })
      expect(r.status(), `switch to ${mode} auth mode`).toBe(200)
      expect((await r.json()).authMode).toBe(mode)
    },
    /** Friend with a username + a password whose forced-change flag is CLEARED. */
    async friendWithLogin(label, { keepForcedChange = false } = {}) {
      const name = `GA4 ${label}`
      const username = `ga4${label}`.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30)
      const created = await ctx.post('/api/friends', { headers: admin(), data: { name } })
      expect(created.status(), 'friend create').toBe(201)
      const friend = await created.json()
      expect((await ctx.put(`/api/friends/${friend.id}/admin-username`, {
        headers: admin(), data: { username },
      })).status(), 'admin-username').toBe(200)
      expect((await ctx.put(`/api/friends/${friend.id}/reset-password`, {
        headers: admin(), data: { password: 'initPass123' },
      })).status(), 'reset-password').toBe(200)

      let password = 'initPass123'
      if (!keepForcedChange) {
        // The only way to clear `must_change_password` is the friend's own change —
        // exactly the flow a real friend goes through.
        const auth = await ctx.post('/api/friends/auth', { data: { username, password } })
        expect(auth.status(), 'seed login').toBe(200)
        const token = (await auth.json()).token
        const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
          headers: { Authorization: `Bearer ${token}` },
          data: { currentPassword: password, newPassword: 'ownPass123' },
        })
        expect(chg.status(), 'clear forced change').toBe(200)
        password = 'ownPass123'
      }
      return { ...friend, username, password }
    },
    /** The link GA-T5 will write. No route creates one yet. */
    linkGoogle(id, { sub, email = null, dismissed = 0 }) {
      withDb((db) => {
        db.prepare('UPDATE friends SET google_sub = ?, google_email = ?, google_prompt_dismissed = ? WHERE id = ?')
          .run(sub, email, dismissed ? 1 : 0, Number(id))
      })
    },
    row(id) {
      return withDb((db) => db.prepare(
        'SELECT id, active, google_sub, google_email, google_prompt_dismissed, must_change_password FROM friends WHERE id = ?'
      ).get(Number(id)))
    },
    async deactivate(id) {
      const r = await ctx.patch(`/api/friends/${id}`, { headers: admin(), data: { active: 0 } })
      expect(r.status(), 'deactivate').toBe(200)
    },
    googleLogin(body, opts = {}) {
      return ctx.post('/api/friends/auth/google', { data: body, ...opts })
    },
    passwordLogin(username, password) {
      return ctx.post('/api/friends/auth', { data: { username, password } })
    },

    // ── GA-T5 (§UC-GA-004) ───────────────────────────────────────────────────
    /** A friend with NO credentials at all — the `warning: 'no_password'` fixture. */
    async plainFriend(label) {
      const created = await ctx.post('/api/friends', { headers: admin(), data: { name: `GA5 ${label}` } })
      expect(created.status(), 'friend create').toBe(201)
      return created.json()
    },
    async givePassword(id, password = 'somePass123') {
      const r = await ctx.put(`/api/friends/${id}/reset-password`, { headers: admin(), data: { password } })
      expect(r.status(), 'reset-password').toBe(200)
    },
    /**
     * A per-friend session for a friend who may have NO password.
     *
     * ⚠ The legacy shared-password branch of `POST /friends/auth` mints a per-friend
     * session too (`friends.js:225`), which is the ONLY way to get a Bearer token for a
     * credential-less friend — and a credential-less friend is exactly the
     * `warning: 'no_password'` fixture. The harness backend is seeded legacy, and
     * §UC-GA-004 puts no auth-mode guard on these three routes (unlike §UC-GA-003's
     * login), so legacy is a legitimate place to exercise them.
     */
    async sessionFor(friendId) {
      const r = await ctx.post('/api/friends/auth', { data: { password: FRIENDS_PASSWORD, friendId } })
      expect(r.status(), 'legacy per-friend session mint').toBe(200)
      const body = await r.json()
      expect(typeof body.token, 'the legacy mint really returns a token').toBe('string')
      return body.token
    },
    /**
     * A session for a friend from `friendWithLogin` — works in EITHER mode, and is the
     * only way to get one in modern mode (where `sessionFor`'s shared-password mint is
     * refused, which is the whole point of modern mode).
     */
    async loginToken(friend) {
      const r = await ctx.post('/api/friends/auth', { data: { username: friend.username, password: friend.password } })
      expect(r.status(), `personal login for ${friend.username}`).toBe(200)
      return (await r.json()).token
    },
    bearer: (token) => ({ Authorization: `Bearer ${token}` }),
    linkReq(id, token, body) {
      return ctx.put(`/api/friends/${id}/google-link`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        data: body,
      })
    },
    unlinkReq(id, token) {
      return ctx.delete(`/api/friends/${id}/google-link`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
    },
    dismissReq(id, token) {
      return ctx.post(`/api/friends/${id}/google-prompt-dismissed`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
    },
    /** Identity-less shared-password auth — the requireHost precedent's reject case. */
    sharedPasswordHeaders: () => ({ 'X-Friends-Password': FRIENDS_PASSWORD }),

    // ── GA-T8 (§UC-GA-008) ───────────────────────────────────────────────────
    /**
     * A REAL invite code. `friends.js` strips `invite_code` from every friend
     * response, so `GET /invitations/my-code` on the friend's own Bearer session is
     * the only route to one (the `invite-register-shell.spec.js` idiom).
     */
    async inviteCode(label) {
      const friend = await api.friendWithLogin(label)
      const token = await api.loginToken(friend)
      const r = await ctx.get('/api/invitations/my-code', { headers: api.bearer(token) })
      expect(r.status(), 'my-code').toBe(200)
      const code = (await r.json()).inviteCode
      expect(code, 'the inviter must really have a code').toBeTruthy()
      return { friend, code }
    },
    register(data) {
      return ctx.post('/api/invitations/register', { data })
    },
    /** The stored row, read straight from sqlite — the response says only `success`. */
    invitationRow(phone) {
      return withDb((db) => db.prepare(
        'SELECT id, invite_code, invited_by_friend_id, name, phone, email, username, status, source, google_sub, google_email FROM invitations WHERE phone = ?'
      ).get(phone))
    },
    invitationCount() {
      return withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM invitations').get().n)
    },
    setInvitationStatus(id, status) {
      withDb((db) => db.prepare('UPDATE invitations SET status = ? WHERE id = ?').run(status, Number(id)))
    },
  }
  return { api }
}

// Every successful registration must carry a distinct phone: the shipped pending
// dedupe (`idx_invitations_phone_pending`) 409s a repeat, so a shared number would
// make a later test fail for a reason that is not under test.
let phoneSeq = 0
const uniquePhone = () => `+4219${String(Date.now() % 1e5).padStart(5, '0')}${String(++phoneSeq).padStart(3, '0')}`

// ═════════════════════════════════════════════════════════════════════════════
// §UC-GA-003 — the endpoint, on a modern throwaway backend
// ═════════════════════════════════════════════════════════════════════════════

test.describe('§UC-GA-003 — POST /api/friends/auth/google', () => {
  test('happy path: the response is the password login\'s personal branch + exactly two additive fields, and never names google_sub', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api, ctx }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('happy'))
      const sub = tag('sub-happy')
      api.linkGoogle(friend.id, { sub, email: 'linked@example.test' })

      const res = await api.googleLogin({ id_token: `TEST:${sub}:linked@example.test` })
      expect(res.status(), 'linked + active friend logs in').toBe(200)

      // ⚠ The strip pin, on raw bytes.
      const raw = await res.text()
      expect(raw.match(STRIP_RE) || [], 'google_sub must appear zero times in the body').toEqual([])

      const body = JSON.parse(raw)
      // Byte-compatible with `POST /friends/auth`'s personal branch + the two additive
      // fields, and NOTHING ELSE — an exact key set, because a hand-picked response
      // becoming a spread is precisely what the strip rule exists to catch.
      expect(Object.keys(body).sort()).toEqual([
        'expiresAt', 'friend', 'googleLinked', 'googlePromptDismissed',
        'hasCredentials', 'mustChangePassword', 'success', 'token',
      ])
      expect(Object.keys(body.friend).sort()).toEqual(['id', 'name', 'packeta_address', 'uid', 'username'])
      expect(body.success).toBe(true)
      expect(body.friend.id).toBe(friend.id)
      expect(body.friend.username).toBe(friend.username)
      expect(body.hasCredentials).toBe(true)
      expect(body.mustChangePassword).toBe(false)
      expect(body.googleLinked).toBe(true)
      expect(body.googlePromptDismissed).toBe(false)
      expect(typeof body.token).toBe('string')
      expect(typeof body.expiresAt).toBe('number')

      // The token is a real session, not a decoration.
      const cycles = await ctx.get('/api/friends/cycles', { headers: { Authorization: `Bearer ${body.token}` } })
      expect(cycles.status(), 'the minted session authenticates').toBe(200)
    })
  })

  test('an unknown sub gets the explicit-link hint WITH code:not_linked — and no session', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const res = await api.googleLogin({ id_token: `TEST:${tag('sub-nobody')}:nobody@example.test` })
      expect(res.status()).toBe(401)
      const body = await res.json()
      expect(body.error, 'the hint 01 mandates, verbatim').toBe(NOT_LINKED_ERROR)
      expect(body.code, 'the machine-readable discriminator UC-GA-003 names').toBe('not_linked')
      expect(body.token, 'no session on a failed login').toBeUndefined()
    })
  })

  test('a LINKED but INACTIVE friend gets the GENERIC 401 — no code, no hint, no session', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('inactive'))
      const sub = tag('sub-inactive')
      api.linkGoogle(friend.id, { sub })
      await api.deactivate(friend.id)
      expect(api.row(friend.id).active, 'fixture really is inactive').toBeFalsy()

      const res = await api.googleLogin({ id_token: `TEST:${sub}:x@example.test` })
      expect(res.status()).toBe(401)
      const body = await res.json()
      // ⚠ THE TWO-STEP LOOKUP IS THE MECHANISM. A single
      // `WHERE google_sub = ? AND active = 1` would collapse this case into the
      // not-linked branch and tell a deactivated friend (or anyone holding their
      // Google account) that the link exists.
      expect(body.error, 'the same generic message password login gives').toBe(GENERIC_401)
      expect(body.code, 'an inactive friend must not learn their linked state').toBeUndefined()
      expect(body.token).toBeUndefined()
    })
  })

  test('must_change_password propagates as mustChangePassword (resolved decision #1)', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('forced'), { keepForcedChange: true })
      expect(api.row(friend.id).must_change_password, 'fixture really is flagged').toBeTruthy()
      const sub = tag('sub-forced')
      api.linkGoogle(friend.id, { sub })

      const res = await api.googleLogin({ id_token: `TEST:${sub}:x@example.test` })
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.mustChangePassword, 'a Google login must not bypass the forced gate').toBe(true)
      // ⚠ And it is NOT refused: the login succeeds and the gate fires client-side,
      // exactly as after a password login.
      expect(typeof body.token).toBe('string')
    })
  })

  test('googlePromptDismissed reflects the stored column', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('dismissed'))
      const sub = tag('sub-dismissed')
      api.linkGoogle(friend.id, { sub, dismissed: 1 })
      const body = await (await api.googleLogin({ id_token: `TEST:${sub}:x@example.test` })).json()
      expect(body.googlePromptDismissed).toBe(true)
    })
  })

  test('google_email is refreshed when the verified token carries a different address', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('mailrefresh'))
      const sub = tag('sub-mailrefresh')
      api.linkGoogle(friend.id, { sub, email: 'old@example.test' })

      expect((await api.googleLogin({ id_token: `TEST:${sub}:new@example.test` })).status()).toBe(200)
      const row = api.row(friend.id)
      expect(row.google_email, 'display-only column follows the token').toBe('new@example.test')
      expect(row.google_sub, 'the identity key is never rewritten by a login').toBe(sub)
    })
  })

  test('remember forwards to the mint: opt-in buys the long horizon, omission does not', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('remember'))
      const sub = tag('sub-remember')
      api.linkGoogle(friend.id, { sub })

      const short = await (await api.googleLogin({ id_token: `TEST:${sub}:x@example.test` })).json()
      const long = await (await api.googleLogin({ id_token: `TEST:${sub}:x@example.test`, remember: true })).json()
      const day = 24 * 60 * 60 * 1000
      expect(long.expiresAt - short.expiresAt, 'remember:true must buy strictly more').toBeGreaterThan(20 * day)
      expect(short.expiresAt - Date.now(), 'the default horizon stays short').toBeLessThan(2 * day)
    })
  })

  test('the token type guard answers 400 with a field marker, never a 500', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      for (const [label, body] of [
        ['a number', { id_token: 123 }],
        ['an object', { id_token: {} }],
        ['absent', {}],
        ['empty string', { id_token: '   ' }],
        ['over 4096 chars', { id_token: 'x'.repeat(4097) }],
      ]) {
        const res = await api.googleLogin(body)
        expect(res.status(), `${label} ⇒ 400`).toBe(400)
        const json = await res.json()
        expect(json.error, label).toBe(BAD_TOKEN)
        expect(json.field, label).toBe('id_token')
      }
    })
  })

  test('a well-formed but unverifiable token is a 401, not a 500 — and never a not_linked hint', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      // The seam is on for `TEST:` tokens only, so this string takes the REAL path.
      //
      // ⚠ IT COSTS NO OUTBOUND REQUEST — but credit that to OUR shape gate, not to
      // the library. `looksLikeCompactJws` (`helpers/google-auth.js:247`) rejects a
      // non-JWS string before anything is called; `verifyIdTokenAsync` fetches the
      // certs BEFORE it looks at the token, so without that gate a junk string would
      // reach the network in the cold-start / post-expiry window. The helper says so
      // in its own comment. Recorded here because "the library fails locally at
      // decode" is the plausible wrong reason someone would delete a load-bearing
      // gate on — and deleting it would also make this test non-hermetic.
      const res = await api.googleLogin({ id_token: 'not-a-jwt-at-all' })
      expect(res.status()).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Prihlásenie cez Google zlyhalo')
      expect(body.code, 'a failed verification must not claim the account is merely unlinked').toBeUndefined()
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §UC-GA-003 — the ORDER of the guards. Getting it wrong leaks state.
// ═════════════════════════════════════════════════════════════════════════════

test.describe('§UC-GA-003 — guard order: config → legacy → verify → lookup', () => {
  test('legacy mode ⇒ 409 even for a token that WOULD verify (verification never runs)', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      // Deliberately NOT switching to modern — the seeded default is legacy.
      const friend = await api.friendWithLogin(tag('legacy'))
      const sub = tag('sub-legacy')
      api.linkGoogle(friend.id, { sub })

      const res = await api.googleLogin({ id_token: `TEST:${sub}:x@example.test` })
      expect(res.status(), 'resolved decision #2').toBe(409)
      const body = await res.json()
      expect(body.error).toBe(LEGACY_409)
      expect(body.field).toBe('auth_mode')
      expect(body.token, 'no session in legacy mode').toBeUndefined()
      // ⚠ The point of the ORDER: a deployment with Google switched off must not
      // confirm that a token was valid, nor that a sub is linked.
      expect(body.code).toBeUndefined()
    })
  })

  test('unconfigured ⇒ 503 first, ahead of the mode guard and ahead of any token complaint', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    // The suite default HAS the var set (§UC-GA-013), so the unconfigured case needs
    // its own server run.
    await withGoogleBackend({ GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_TEST_MODE: '' }, async ({ api, ctx }) => {
      await api.setModernMode()

      for (const [label, body] of [
        ['a valid-shaped seam token', { id_token: 'TEST:whoever:x@example.test' }],
        ['a number', { id_token: 123 }],
        ['no token at all', {}],
      ]) {
        const res = await api.googleLogin(body)
        expect(res.status(), `${label} ⇒ 503, the feature is simply off`).toBe(503)
        expect((await res.json()).error, label).toBe(NOT_CONFIGURED)
      }

      // ⚠ And the public config says so, which is what hides every frontend control.
      const mode = await ctx.get('/api/friends/auth-mode')
      expect((await mode.json()).googleClientId, 'null, not absent, not ""').toBeNull()
    })
  })

  test('legacy mode wins over a bad token — the mode guard precedes verification', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const res = await api.googleLogin({ id_token: 123 })
      expect(res.status(), 'a 400 here would prove verification ran first').toBe(409)
      expect((await res.json()).error).toBe(LEGACY_409)
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §UC-GA-013 — the rate-limit rule: authLimiter, no new bucket
// ═════════════════════════════════════════════════════════════════════════════

test.describe('§UC-GA-013 — Google login sits on authLimiter', () => {
  test('it shares the strict bucket with /friends/auth — exhausting one exhausts the other', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    // Low enough to exhaust quickly, high enough to survive the harness's own admin
    // login (`/api/admin/login` is on the same bucket).
    await withGoogleBackend({ RATE_LIMIT_AUTH_MAX: '12' }, async ({ api, ctx }) => {
      let limited = false
      for (let i = 0; i < 30 && !limited; i++) {
        const res = await api.googleLogin({ id_token: `TEST:nobody-${i}:x@example.test` })
        if (res.status() === 429) limited = true
      }
      expect(limited, 'Google login must be rate limited at all').toBe(true)

      // ⚠ THE ACTUAL CLAIM: the SAME bucket, not a new one. A private bucket would
      // leave password login untouched here.
      const pw = await ctx.post('/api/friends/auth', { data: { username: 'nobody', password: 'nope' } })
      expect(pw.status(), 'password login shares the bucket (no new limiter)').toBe(429)

      // A non-limited public endpoint still answers, so the 429s above are the
      // limiter and not a dead server.
      expect((await ctx.get('/api/friends/auth-mode')).status()).toBe(200)
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §UC-GA-003 — the two additive fields on the PASSWORD login response
// ═════════════════════════════════════════════════════════════════════════════

test.describe('§UC-GA-003 — password login gains googleLinked + googlePromptDismissed', () => {
  test('an unlinked friend reads false/false; a linked one reads its real state — same handshake, no extra request', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()

      const plain = await api.friendWithLogin(tag('pwplain'))
      const before = await api.passwordLogin(plain.username, plain.password)
      expect(before.status()).toBe(200)
      const beforeRaw = await before.text()
      expect(beforeRaw.match(STRIP_RE) || [], 'the password response is stripped too').toEqual([])
      const beforeBody = JSON.parse(beforeRaw)
      expect(beforeBody.googleLinked).toBe(false)
      expect(beforeBody.googlePromptDismissed).toBe(false)
      // ⚠ Additive ONLY — nothing that existed before moved or changed meaning.
      expect(Object.keys(beforeBody).sort()).toEqual([
        'expiresAt', 'friend', 'googleLinked', 'googlePromptDismissed',
        'hasCredentials', 'mustChangePassword', 'success', 'token',
      ])
      expect(beforeBody.hasCredentials).toBe(true)

      api.linkGoogle(plain.id, { sub: tag('sub-pw'), email: 'pw@example.test', dismissed: 1 })
      const after = await (await api.passwordLogin(plain.username, plain.password)).json()
      expect(after.googleLinked).toBe(true)
      expect(after.googlePromptDismissed).toBe(true)
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The gate server: the state it is actually in, and target-agnostic
// ═════════════════════════════════════════════════════════════════════════════

test.describe('§UC-GA-003 — against whatever this target is configured as', () => {
  test('the endpoint exists and answers its documented guard for this deployment', async ({ request }) => {
    const mode = await (await request.get('/api/friends/auth-mode')).json()
    const res = await request.post('/api/friends/auth/google', {
      data: { id_token: `TEST:ga4-gate-${uniq}:x@example.test` },
    })
    const body = await res.json()

    if (mode.googleClientId === null) {
      expect(res.status(), 'unconfigured deployment').toBe(503)
      expect(body.error).toBe(NOT_CONFIGURED)
    } else if (mode.authMode !== 'modern') {
      expect(res.status(), 'configured but not modern ⇒ resolved decision #2').toBe(409)
      expect(body.error).toBe(LEGACY_409)
      expect(body.field).toBe('auth_mode')
    } else {
      // Modern + configured: an unlinked sub is the hint. (With the seam OFF the token
      // is simply invalid, which is the other legal answer.)
      expect(res.status()).toBe(401)
      expect([NOT_LINKED_ERROR, 'Prihlásenie cez Google zlyhalo']).toContain(body.error)
    }
    expect(await res.text()).not.toMatch(STRIP_RE)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §UC-GA-005 — the login card's Google control: presence, absence, and the
// request that presence implies
// ═════════════════════════════════════════════════════════════════════════════

const GIS_HOST = 'accounts.google.com'

// A stand-in for `https://accounts.google.com/gsi/client`. It defines the namespace
// `lib/gis.js` waits for and RECORDS what the view asks of it, which is as far inward
// as any test can go — the real library renders a cross-origin iframe.
//
// ⚠ It is served through `page.route`, so nothing in this file ever reaches Google.
const GIS_STUB = `
  window.__gisCalls = { initialize: [], renderButton: [] };
  window.google = { accounts: { id: {
    initialize: (cfg) => {
      window.__gisCalls.initialize.push({ client_id: cfg.client_id, hasCallback: typeof cfg.callback === 'function' })
      // ⚠ GA-T6 addition. The real GIS keeps ONE global callback, registered by the
      // LAST \`initialize()\` — so recording it here is not a convenience, it is the
      // only way a test can (a) fire a credential at whoever currently owns the
      // callback and (b) observe that ownership moving between the login card and
      // the post-login prompt. GA-T4's assertions read only the two fields above and
      // are unaffected.
      window.__gisCallback = cfg.callback
    },
    renderButton: (el, opts) => {
      window.__gisCalls.renderButton.push({ testid: el && el.getAttribute('data-testid'), opts })
      const marker = document.createElement('div')
      marker.setAttribute('data-testid', 'gis-stub-button')
      marker.textContent = 'Prihlásiť sa cez Google'
      el.appendChild(marker)
    },
  } } };
`

/** Count and neutralise every request to Google; returns the collected URLs. */
async function trackGoogle(page, { fulfilWith = null } = {}) {
  const hits = []
  await page.route(`https://${GIS_HOST}/**`, (route) => {
    hits.push(route.request().url())
    if (fulfilWith === null) return route.abort()
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: fulfilWith })
  })
  return hits
}

function stubAuthMode(page, payload) {
  return page.route('**/friends/auth-mode', (route) => route.fulfill({ json: payload }))
}

test.describe('§UC-GA-005 — the Google button on the friend login card', () => {
  test('modern + configured ⇒ the "alebo" divider, the GIS button, and a real GIS load', async ({ page }) => {
    const hits = await trackGoogle(page, { fulfilWith: GIS_STUB })
    await stubAuthMode(page, { authMode: 'modern', googleClientId: 'gate-client-id' })
    await page.goto('/')

    // The password group is untouched — this row composes with ML-T4/ML-T5, it does
    // not reorder them.
    await expect(page.getByRole('button', { name: 'Prihlásiť sa' })).toBeVisible()
    await expect(page.getByTestId('forgot-password')).toBeVisible()

    const divider = page.getByTestId('google-divider')
    await expect(divider).toBeVisible()
    await expect(divider).toHaveText('alebo')

    const container = page.getByTestId('google-signin')
    await expect(container).toBeVisible()
    await expect(page.getByTestId('gis-stub-button')).toBeVisible()

    // ⚠ The RD-DS-6 lesson: assert the REQUEST, not just the DOM.
    expect(hits.filter((u) => u.includes('/gsi/client')).length,
      'the loader must actually fetch the GIS client').toBeGreaterThan(0)

    const calls = await page.evaluate(() => window.__gisCalls)
    expect(calls.initialize.length, 'initialize is the view\'s job, not the loader\'s').toBe(1)
    expect(calls.initialize[0].client_id, 'the SERVED client id, not a build-time constant').toBe('gate-client-id')
    expect(calls.initialize[0].hasCallback).toBe(true)
    expect(calls.renderButton.length).toBe(1)
    expect(calls.renderButton[0].testid, 'rendered into our own container').toBe('google-signin')
    expect(calls.renderButton[0].opts.locale, '§UC-GA-005').toBe('sk')
    expect(calls.renderButton[0].opts.width, 'GIS caps at 400').toBeLessThanOrEqual(400)

    // The divider sits BELOW the submit button (the ML-T5 layout seam: the password
    // group keeps its slot, Google goes after it).
    const submitBox = await page.getByRole('button', { name: 'Prihlásiť sa' }).boundingBox()
    const dividerBox = await divider.boundingBox()
    expect(dividerBox.y, 'the Google block goes below the whole password group').toBeGreaterThan(submitBox.y)
  })

  test('modern + googleClientId EXPLICITLY null ⇒ no divider, no button, zero requests to Google', async ({ page }) => {
    // ⚠ NON-VACUOUS BY CONSTRUCTION. The stub CARRIES the key with a `null` value, so
    // this asserts the flag is the gate — unlike a stub that omits it, against which a
    // button ignoring the flag entirely would also pass.
    const hits = await trackGoogle(page)
    await stubAuthMode(page, { authMode: 'modern', googleClientId: null })
    await page.goto('/')

    await expect(page.getByRole('button', { name: 'Prihlásiť sa' })).toBeVisible()
    await expect(page.getByTestId('google-divider')).toHaveCount(0)
    await expect(page.getByTestId('google-signin')).toHaveCount(0)
    await page.waitForLoadState('networkidle')
    expect(hits, 'an unconfigured deployment must be Google-free').toEqual([])
  })

  test('LEGACY mode + configured ⇒ the card is byte-identical to today: no Google control, zero requests', async ({ page }) => {
    // ⚠ NO STUB AT ALL. The gate really is legacy and (for this run) really is
    // configured, so this is the resolved-decision-#2 case observed for real — the
    // strongest form of the absence assertion, because nothing here can be vacuous.
    const hits = await trackGoogle(page)
    await page.goto('/')
    const mode = await (await page.request.get('/api/friends/auth-mode')).json()
    test.skip(mode.authMode === 'modern', 'this target is in modern mode; the legacy card does not render')

    await expect(page.getByTestId('google-divider')).toHaveCount(0)
    await expect(page.getByTestId('google-signin')).toHaveCount(0)
    await page.waitForLoadState('networkidle')
    expect(hits, `legacy mode must render no Google control (googleClientId=${mode.googleClientId})`).toEqual([])
  })

  test('the divider text is exactly "alebo" and the button is not restyled into the card\'s language', async ({ page }) => {
    await trackGoogle(page, { fulfilWith: GIS_STUB })
    await stubAuthMode(page, { authMode: 'modern', googleClientId: 'gate-client-id' })
    await page.goto('/')
    // Google's brand guidelines forbid restyling the GIS button, so the container must
    // stay a bare mount point — no `.btn`, no theme class on it.
    const cls = await page.getByTestId('google-signin').getAttribute('class')
    expect(cls || '', 'the GIS iframe mount must carry no theme button class').not.toMatch(/\bbtn\b/)
    await expect(page.getByTestId('google-divider')).toHaveText('alebo')
  })

  test('the recovery view (ML-T4) hides the Google block — one card, one purpose at a time', async ({ page }) => {
    await trackGoogle(page, { fulfilWith: GIS_STUB })
    await stubAuthMode(page, { authMode: 'modern', googleClientId: 'gate-client-id' })
    await page.goto('/')
    await expect(page.getByTestId('google-signin')).toBeVisible()
    await page.getByTestId('forgot-password').click()
    await expect(page.getByTestId('recovery-form')).toBeVisible()
    await expect(page.getByTestId('google-signin')).toHaveCount(0)

    // ⚠ AND IT COMES BACK, rendered. The `v-if` destroys the container, so a button
    // that is only rendered once would leave an EMPTY div here — visually a gap in the
    // card, functionally no way in. Nothing but this round trip can see that.
    await page.getByRole('button', { name: 'Späť na prihlásenie' }).click()
    await expect(page.getByTestId('google-signin')).toBeVisible()
    await expect(page.getByTestId('gis-stub-button')).toBeVisible()
    const calls = await page.evaluate(() => window.__gisCalls)
    expect(calls.renderButton.length, 'the button is re-rendered into the new container').toBe(2)
    expect(calls.initialize.length, 'initialize registers ONE global callback, once').toBe(1)
  })
})

test.describe('§UC-GA-012 — the guest and magic-link surfaces stay Google-free', () => {
  test('/g/:token and /magic/:token make zero requests to Google even with a client id configured', async ({ page, request }) => {
    const mode = await (await request.get('/api/friends/auth-mode')).json()
    test.skip(mode.googleClientId === null, 'nothing to prove on an unconfigured target')

    for (const url of [`/g/nosuchtoken${uniq}`, `/magic/${'f'.repeat(64)}`]) {
      const hits = await trackGoogle(page)
      await page.goto(url)
      await page.waitForLoadState('networkidle')
      expect(hits, `${url} must never load GIS`).toEqual([])
      await page.unrouteAll()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GA-T5 — §UC-GA-004: the friend-owned link / unlink / prompt-dismiss endpoints
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠⚠ WHICH MODE EACH HALF RUNS IN, AND WHY IT IS NOT ARBITRARY.
//
// `PUT /:id/google-link` is MODERN-ONLY (resolved decision #2, the same guard
// `POST /auth/google` carries), so its accept-path tests need a modern throwaway
// backend — GA-T4's pattern, in this same file, for the same reason (`e2e/seed.mjs`
// pins the shared gate to legacy and `modern-login.spec.js` asserts nobody wrote
// `auth_mode`).
//
// ⚠ THE GUARD IS A SECURITY CONTROL, NOT HOUSEKEEPING, AND THE FIRST VERSION OF THIS
// FILE PINNED THE HOLE AS ALLOWED. The legacy dropdown login mints a per-friend
// session for ANY friend from the shared office password alone (`POST /friends/auth`
// with `{ password: <shared>, friendId: <victim> }`), so the "resolved identity"
// requirement §UC-GA-004 states is satisfied by an attacker in TWO requests. A link
// planted that way is inert while legacy — and becomes a permanent alternative
// credential the instant the admin flips to modern, surviving the victim's own
// password change. Hence: every legacy `PUT` is refused, and there is an explicit
// test below asserting the 409 so the hole stays closed BY ASSERTION rather than by
// the absence of a test.
//
// The unlink and the prompt-dismiss have NO mode guard (§UC-GA-004 puts one on
// neither, and neither creates a credential), so they are exercised in LEGACY — which
// is the stricter place for them, because legacy is the only mode in which
// `requireFriendOwner` resolves `friendId: null` at all, i.e. the only mode where the
// identity-less reject case (the `requireHost` precedent) is reachable. Their link
// fixtures are seeded by direct column write (`api.linkGoogle`, GA-T4's helper) so
// they do not depend on the route that is now mode-gated.
//
// The 409 collision message, verbatim. Asserted as a literal for the same reason the
// UC-GA-003 strings are: the whole point of "no information about WHICH friend, ever"
// is that this one sentence is the entire body.
const LINK_CONFLICT = 'Tento Google účet je už prepojený s iným účtom'
const NO_IDENTITY_401 = 'Prihláste sa svojím menom a heslom'
const FORBIDDEN_403 = 'Nemáte oprávnenie na tento účet'

test.describe('§UC-GA-004 — PUT /api/friends/:id/google-link (modern mode)', () => {
  test('links an unlinked friend: 200 {googleLinked,googleEmail}, the row carries sub + email, and the body never names google_sub', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('link'))
      const token = await api.loginToken(friend)
      const sub = tag('sub-link')

      const res = await api.linkReq(friend.id, token, { id_token: `TEST:${sub}:me@example.test` })
      expect(res.status(), 'the owner links their own account').toBe(200)

      const raw = await res.text()
      // ⚠ The strip pin on RAW BYTES (§UC-GA-004's last acceptance criterion, the
      // UC-IA-005 pattern): a future `SELECT *` spread would add the identity key back
      // under its own name, and a key-list assertion over the fields we happen to know
      // about would not notice.
      expect(raw.match(STRIP_RE) || [], 'google_sub must appear zero times').toEqual([])

      const body = JSON.parse(raw)
      expect(Object.keys(body).sort(), 'the exact response §UC-GA-004 specifies').toEqual([
        'googleEmail', 'googleLinked',
      ])
      expect(body.googleLinked).toBe(true)
      expect(body.googleEmail).toBe('me@example.test')

      const row = api.row(friend.id)
      expect(row.google_sub, 'the identity key is stored').toBe(sub)
      expect(row.google_email, 'the display address is stored').toBe('me@example.test')
      expect(Number(row.google_prompt_dismissed), 'linking does not touch the prompt flag').toBe(0)
    })
  })

  test('the SAME sub on THIS friend is idempotent 200 and refreshes google_email', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('idem'))
      const token = await api.loginToken(friend)
      const sub = tag('sub-idem')

      expect((await api.linkReq(friend.id, token, { id_token: `TEST:${sub}:first@example.test` })).status()).toBe(200)
      const again = await api.linkReq(friend.id, token, { id_token: `TEST:${sub}:second@example.test` })
      expect(again.status(), 're-linking the same account is not a conflict with itself').toBe(200)
      expect((await again.json()).googleEmail).toBe('second@example.test')

      const row = api.row(friend.id)
      expect(row.google_sub, 'the identity key is unchanged').toBe(sub)
      expect(row.google_email, 'the display-only column follows the newest token').toBe('second@example.test')
    })
  })

  test('an UNVERIFIED address never wipes a stored one on the same sub — but a REPLACE clears it', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('mailkeep'))
      const token = await api.loginToken(friend)
      const sub = tag('sub-mailkeep')

      expect((await api.linkReq(friend.id, token, { id_token: `TEST:${sub}:keep@example.test` })).status()).toBe(200)

      // ⚠ `TEST:<sub>:` with an EMPTY address half is the seam's way of producing what
      // an `email_verified: false` token produces on the real path: `email: null`
      // (`helpers/google-auth.js` `parseTestToken`). §UC-GA-004's literal
      // `SET google_sub = ?, google_email = ?` would silently blank the address the
      // friend already has — `POST /auth/google` guards the same column, and the two
      // Google write paths must not disagree.
      const again = await api.linkReq(friend.id, token, { id_token: `TEST:${sub}:` })
      expect(again.status()).toBe(200)
      expect((await again.json()).googleEmail, 'the response reports what was STORED').toBe('keep@example.test')
      expect(api.row(friend.id).google_email, 'the stored address survives').toBe('keep@example.test')

      // ⚠ The other half: on a DIFFERENT account the old address must go, or the
      // profile would show the PREVIOUS account's e-mail beside the new link.
      const other = tag('sub-mailother')
      const replaced = await api.linkReq(friend.id, token, { id_token: `TEST:${other}:` })
      expect(replaced.status()).toBe(200)
      expect((await replaced.json()).googleEmail).toBeNull()
      const row = api.row(friend.id)
      expect(row.google_sub).toBe(other)
      expect(row.google_email, 'a replace does not inherit the old address').toBeNull()
    })
  })

  test('a DIFFERENT sub REPLACES the link in one write — no unlink ceremony, and the old sub is freed', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('replace'))
      const token = await api.loginToken(friend)
      const oldSub = tag('sub-old')
      const newSub = tag('sub-new')

      expect((await api.linkReq(friend.id, token, { id_token: `TEST:${oldSub}:old@example.test` })).status()).toBe(200)
      const res = await api.linkReq(friend.id, token, { id_token: `TEST:${newSub}:new@example.test` })
      expect(res.status(), 'a friend re-linking a new Google account needs no unlink first').toBe(200)

      const row = api.row(friend.id)
      expect(row.google_sub).toBe(newSub)
      expect(row.google_email).toBe('new@example.test')

      // ⚠ The replacement really RELEASED the old sub — otherwise "replace" would be
      // "add", and the partial UNIQUE index would eventually refuse a legitimate link.
      const other = await api.friendWithLogin(tag('replaceother'))
      const otherToken = await api.loginToken(other)
      expect((await api.linkReq(other.id, otherToken, { id_token: `TEST:${oldSub}:x@example.test` })).status(),
        'the released sub is linkable by somebody else').toBe(200)
    })
  })

  test('a sub held by ANOTHER friend ⇒ 409 whose body names no friend at all', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const holder = await api.friendWithLogin(tag('holder'))
      const holderToken = await api.loginToken(holder)
      const sub = tag('sub-collide')
      expect((await api.linkReq(holder.id, holderToken, { id_token: `TEST:${sub}:holder@example.test` })).status()).toBe(200)

      const other = await api.friendWithLogin(tag('collider'))
      const otherToken = await api.loginToken(other)
      const res = await api.linkReq(other.id, otherToken, { id_token: `TEST:${sub}:holder@example.test` })
      expect(res.status()).toBe(409)

      const raw = await res.text()
      const body = JSON.parse(raw)
      expect(Object.keys(body).sort(), 'error + field, and NOTHING else').toEqual(['error', 'field'])
      expect(body.error).toBe(LINK_CONFLICT)
      expect(body.field).toBe('google')

      // ⚠ THE ENUMERATION-ORACLE PIN. Naming the holder — id, name, uid, username, or
      // the address on their account — would turn linking into a lookup across the
      // whole friend table for anyone who can obtain a Google token.
      const holderRow = api.row(holder.id)
      for (const secret of [String(holder.id), holder.name, holder.uid, holder.username, 'holder@example.test', sub]) {
        expect(raw, `the 409 must not disclose ${JSON.stringify(secret)}`).not.toContain(secret)
      }
      expect(raw.match(STRIP_RE) || []).toEqual([])

      // Neither row moved.
      expect(holderRow.google_sub, "the holder's link survives the attempt").toBe(sub)
      expect(api.row(other.id).google_sub, 'the refused friend gained nothing').toBeNull()
    })
  })

  test('the collision is NOT scoped to active friends — a deactivated holder still blocks the sub', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const holder = await api.friendWithLogin(tag('deadholder'))
      const holderToken = await api.loginToken(holder)
      const sub = tag('sub-dead')
      expect((await api.linkReq(holder.id, holderToken, { id_token: `TEST:${sub}:x@example.test` })).status()).toBe(200)
      await api.deactivate(holder.id)

      const other = await api.friendWithLogin(tag('deadcollider'))
      const otherToken = await api.loginToken(other)
      const res = await api.linkReq(other.id, otherToken, { id_token: `TEST:${sub}:x@example.test` })
      // ⚠ An `AND active = 1` in the pre-check would let anyone holding a deactivated
      // colleague's Google account inherit their identity key — and would then rely on
      // the partial index to refuse it, i.e. on the layer that is NOT load-bearing.
      expect(res.status(), 'a deactivated friend still owns their sub').toBe(409)
      expect((await res.json()).error).toBe(LINK_CONFLICT)
    })
  })

  test('friend A cannot link for friend B (403), and nothing is written', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const a = await api.friendWithLogin(tag('ownera'))
      const b = await api.friendWithLogin(tag('ownerb'))
      const aToken = await api.loginToken(a)
      const bToken = await api.loginToken(b)

      const ab = await api.linkReq(b.id, aToken, { id_token: `TEST:${tag('sub-ab')}:x@example.test` })
      expect(ab.status(), "A on B's row").toBe(403)
      expect((await ab.json()).error).toBe(FORBIDDEN_403)
      expect(api.row(b.id).google_sub).toBeNull()

      // ⚠ BOTH DIRECTIONS. A one-way test passes against a guard that compares the
      // wrong pair of ids in exactly one order.
      const ba = await api.linkReq(a.id, bToken, { id_token: `TEST:${tag('sub-ba')}:x@example.test` })
      expect(ba.status(), "B on A's row").toBe(403)
      expect(api.row(a.id).google_sub).toBeNull()
    })
  })

  test('the token guards answer 400 / 401 without writing — and never a 500', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('guards'))
      const token = await api.loginToken(friend)

      for (const [label, body, status, field] of [
        ['a number', { id_token: 123 }, 400, 'id_token'],
        ['an object', { id_token: {} }, 400, 'id_token'],
        ['absent', {}, 400, 'id_token'],
        ['over 4096 chars', { id_token: 'x'.repeat(4097) }, 400, 'id_token'],
        ['a junk string (real verifier path)', { id_token: 'not-a-jwt-at-all' }, 401, undefined],
      ]) {
        const res = await api.linkReq(friend.id, token, body)
        expect(res.status(), `${label}`).toBe(status)
        const json = await res.json()
        if (field) expect(json.field, label).toBe(field)
        expect(api.row(friend.id).google_sub, `${label} wrote nothing`).toBeNull()
      }
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §UC-GA-004 / resolved decision #2 — the LEGACY refusal, and the guard ORDER
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠ THIS DESCRIBE IS THE CLOSED HOLE. Without the mode guard, `PUT …/google-link`
// answered 200 in legacy mode to a session minted from the shared office password —
// planting a Google credential on a colleague's row that activates on the flip to
// modern. Every test here runs on the harness default (legacy), which is what
// production is today.
test.describe('§UC-GA-004 — PUT /api/friends/:id/google-link is refused in legacy mode', () => {
  test('a friend linking their OWN account in legacy mode gets the 409, and nothing is written', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      // Deliberately NOT switching to modern — the seeded default is legacy.
      const friend = await api.plainFriend(tag('legacylink'))
      const token = await api.sessionFor(friend.id)

      const res = await api.linkReq(friend.id, token, { id_token: `TEST:${tag('sub-legacy')}:x@example.test` })
      expect(res.status(), 'resolved decision #2, applied to the link write').toBe(409)
      const body = await res.json()
      expect(body.error, 'byte-identical to POST /auth/google').toBe(LEGACY_409)
      expect(body.field).toBe('auth_mode')
      expect(api.row(friend.id).google_sub, 'no link exists to activate on the flip').toBeNull()
    })
  })

  test('THE ATTACK: the shared office password alone cannot plant a link on somebody else', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api, ctx }) => {
      const victim = await api.plainFriend(tag('victim'))

      // ⚠ STEP 1 IS THE WHOLE POINT: the legacy dropdown login mints a per-friend
      // session for ANY friend from the shared password alone, so an attacker HAS a
      // resolved identity for the victim. `requireFriendOwner` and the identity gate
      // both pass here — they are not what closes this.
      const stolen = await api.sessionFor(victim.id)
      expect(typeof stolen, 'the attacker really holds a victim-scoped session').toBe('string')

      const res = await api.linkReq(victim.id, stolen, { id_token: 'TEST:ATTACKER-SUB:attacker@evil.example' })
      expect(res.status(), 'the mode guard is what refuses it').toBe(409)

      const row = api.row(victim.id)
      expect(row.google_sub, "the victim's row is untouched").toBeNull()
      expect(row.google_email).toBeNull()

      // …and the planted credential would have worked after the flip, which is why the
      // write and not the login is the thing that has to be refused.
      await api.setModernMode()
      const login = await ctx.post('/api/friends/auth/google', {
        data: { id_token: 'TEST:ATTACKER-SUB:attacker@evil.example' },
      })
      expect(login.status(), 'nothing to log in as').toBe(401)
      expect((await login.json()).code).toBe('not_linked')
    })
  })

  test('the ownership and config guards still precede the mode guard', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api, ctx }) => {
      const friend = await api.plainFriend(tag('legacyorder'))

      // ⚠ Anonymous ⇒ 401, NOT 409: the ownership guard runs first, so this route's
      // anonymous answer is the same on every deployment — which is what keeps
      // `api-security.spec.js`'s target-agnostic sweep correct rather than accidental.
      const anon = await ctx.put(`/api/friends/${friend.id}/google-link`, { data: { id_token: 'TEST:x:y@z.test' } })
      expect(anon.status()).toBe(401)

      // ⚠ Identity-less shared-password auth ⇒ 401, NOT 409: the identity gate is
      // ahead of the mode guard, so the `requireHost`-precedent refusal stays
      // observable (and would stay observable if the mode guard were ever relaxed).
      const shared = await ctx.put(`/api/friends/${friend.id}/google-link`, {
        headers: api.sharedPasswordHeaders(),
        data: { id_token: 'TEST:x:y@z.test' },
      })
      expect(shared.status()).toBe(401)
      expect((await shared.json()).error).toBe(NO_IDENTITY_401)
      expect(api.row(friend.id).google_sub).toBeNull()
    })
  })

  test('an unconfigured deployment answers 503 — config precedes the mode guard, mirroring POST /auth/google', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({ GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_TEST_MODE: '' }, async ({ api }) => {
      const friend = await api.plainFriend(tag('off'))
      const token = await api.sessionFor(friend.id)

      const res = await api.linkReq(friend.id, token, { id_token: 'TEST:whoever:x@example.test' })
      // ⚠ 503, not the 409 the same request gets on a CONFIGURED legacy backend: an
      // unconfigured deployment says "the feature is off" and stops.
      expect(res.status()).toBe(503)
      expect((await res.json()).error).toBe(NOT_CONFIGURED)
    })
  })
})

test.describe('§UC-GA-013 — the link endpoint sits on authLimiter', () => {
  test('it shares the strict bucket with /friends/auth — no new bucket for the link', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    // Room for the harness's own admin login plus the fixture's two friend logins,
    // which are on this same bucket.
    await withGoogleBackend({ RATE_LIMIT_AUTH_MAX: '30' }, async ({ api, ctx }) => {
      await api.setModernMode()
      const friend = await api.friendWithLogin(tag('rl'))
      const token = await api.loginToken(friend)
      api.linkGoogle(friend.id, { sub: tag('sub-rl'), email: 'rl@example.test' })

      let limited = false
      let sawHandler = false
      for (let i = 0; i < 60 && !limited; i++) {
        const res = await api.linkReq(friend.id, token, { id_token: 'not-a-jwt-at-all' })
        if (res.status() === 401) sawHandler = true
        if (res.status() === 429) limited = true
      }
      // ⚠ §UC-GA-013's rule: this endpoint ACCEPTS an ID token for verification, so
      // forged-token probing is credential guessing and belongs in the strict bucket.
      expect(sawHandler, 'the route was really reached before the bucket ran out').toBe(true)
      expect(limited, 'the link endpoint must be rate limited at all').toBe(true)

      const pw = await ctx.post('/api/friends/auth', { data: { username: 'nobody', password: 'nope' } })
      expect(pw.status(), 'the SAME bucket, not a private one').toBe(429)

      // ⚠ And the two routes that verify NOTHING are deliberately NOT limited beyond
      // their auth guard — with the auth bucket exhausted they still answer.
      expect((await api.unlinkReq(friend.id, token)).status(), 'unlink needs no limiter').toBe(200)
      expect((await api.dismissReq(friend.id, token)).status(), 'prompt-dismiss needs no limiter').toBe(200)
    })
  })
})

test.describe('§UC-GA-004 — DELETE /api/friends/:id/google-link', () => {
  test('unlink twice ⇒ 200 + 200 with BOTH columns NULL in the row, and the prompt flag untouched', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const friend = await api.plainFriend(tag('unlink'))
      await api.givePassword(friend.id)
      const token = await api.sessionFor(friend.id)
      const sub = tag('sub-unlink')
      // Seeded directly: the unlink has no mode guard and must not depend on the route
      // that does (GA-T4's `linkGoogle` helper, the friends-consolidation precedent).
      api.linkGoogle(friend.id, { sub, email: 'me@example.test' })

      // ⚠ Resolved decision #3, the friend half: the friend said "už sa nepýtať", and
      // severing the LINK must not re-enable the nagging. Symmetric with FC-T3's admin
      // unlink, which carries the same rule.
      expect((await api.dismissReq(friend.id, token)).status()).toBe(200)
      expect(Number(api.row(friend.id).google_prompt_dismissed), 'fixture really is dismissed').toBe(1)

      const first = await api.unlinkReq(friend.id, token)
      expect(first.status()).toBe(200)
      const raw = await first.text()
      expect(raw.match(STRIP_RE) || [], 'google_sub must appear zero times').toEqual([])
      const body = JSON.parse(raw)
      expect(body.googleLinked).toBe(false)
      expect(body.googleEmail).toBeNull()
      expect(body.warning, 'this friend HAS a password, so no warning').toBeUndefined()

      let row = api.row(friend.id)
      expect(row.google_sub, 'read back from the DB, not from the response').toBeNull()
      expect(row.google_email).toBeNull()
      expect(Number(row.google_prompt_dismissed), 'unlink NEVER touches google_prompt_dismissed').toBe(1)

      // ⚠ 200, never 409 (the GSO-T5 DELETE-convergence precedent): a double click, a
      // retry or a second tab must not be answered with an error nobody can act on.
      const second = await api.unlinkReq(friend.id, token)
      expect(second.status(), 'idempotent').toBe(200)
      expect((await second.json()).googleLinked).toBe(false)
      row = api.row(friend.id)
      expect(row.google_sub).toBeNull()
      expect(row.google_email).toBeNull()
      expect(Number(row.google_prompt_dismissed)).toBe(1)
    })
  })

  test('the session survives the unlink — a link is a login METHOD, not the session', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api, ctx }) => {
      const friend = await api.plainFriend(tag('nosessionkill'))
      await api.givePassword(friend.id)
      const token = await api.sessionFor(friend.id)
      api.linkGoogle(friend.id, { sub: tag('sub-keep'), email: 'x@example.test' })

      expect((await api.unlinkReq(friend.id, token)).status()).toBe(200)

      // ⚠ A REAL authenticated request, not a second call to the unlink route: the
      // claim is that the session still works, not that this one route tolerates it.
      const cycles = await ctx.get('/api/friends/cycles', { headers: api.bearer(token) })
      expect(cycles.status(), 'the pre-existing session still authenticates').toBe(200)
      const profile = await ctx.get(`/api/friends/${friend.id}/profile`, { headers: api.bearer(token) })
      expect(profile.status(), 'and still resolves the same identity').toBe(200)
    })
  })

  test("warning:'no_password' appears exactly when the friend has no password_hash — and the unlink still happens", async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const bare = await api.plainFriend(tag('nopass'))
      const bareToken = await api.sessionFor(bare.id)
      api.linkGoogle(bare.id, { sub: tag('sub-nopass'), email: 'x@example.test' })

      const res = await api.unlinkReq(bare.id, bareToken)
      // ⚠ It is ALLOWED, not refused (§UC-GA-004): the friend's own account, and the
      // admin reset is the recovery path. GA-T7's confirm copy consumes this marker.
      expect(res.status(), 'the endpoint still allows it').toBe(200)
      expect((await res.json()).warning).toBe('no_password')
      expect(api.row(bare.id).google_sub, 'and the link really is severed').toBeNull()

      // The counter-case, in the same test, so the marker cannot be unconditional.
      const withPass = await api.plainFriend(tag('haspass'))
      await api.givePassword(withPass.id)
      const t = await api.sessionFor(withPass.id)
      api.linkGoogle(withPass.id, { sub: tag('sub-haspass'), email: 'x@example.test' })
      expect((await (await api.unlinkReq(withPass.id, t)).json()).warning).toBeUndefined()
    })
  })

  test('cross-friend unlink is 403 in both directions, identity-less auth is 401, and neither writes', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api, ctx }) => {
      const a = await api.plainFriend(tag('ua'))
      const b = await api.plainFriend(tag('ub'))
      const aToken = await api.sessionFor(a.id)
      const bToken = await api.sessionFor(b.id)
      const subA = tag('sub-ua')
      const subB = tag('sub-ub')
      api.linkGoogle(a.id, { sub: subA })
      api.linkGoogle(b.id, { sub: subB })

      expect((await api.unlinkReq(b.id, aToken)).status(), 'A unlinking B').toBe(403)
      expect((await api.unlinkReq(a.id, bToken)).status(), 'B unlinking A').toBe(403)
      const shared = await ctx.delete(`/api/friends/${a.id}/google-link`, { headers: api.sharedPasswordHeaders() })
      expect(shared.status(), 'identity-less shared password').toBe(401)

      expect(api.row(a.id).google_sub, "A's link survived").toBe(subA)
      expect(api.row(b.id).google_sub, "B's link survived").toBe(subB)
    })
  })

  test('an unconfigured deployment answers 503 (unlike prompt-dismiss)', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({ GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_TEST_MODE: '' }, async ({ api }) => {
      const friend = await api.plainFriend(tag('offunlink'))
      const token = await api.sessionFor(friend.id)
      const res = await api.unlinkReq(friend.id, token)
      expect(res.status()).toBe(503)
      expect((await res.json()).error).toBe(NOT_CONFIGURED)
    })
  })
})

test.describe('§UC-GA-004 — POST /api/friends/:id/google-prompt-dismissed', () => {
  test('sets the flag, is idempotent, persists across logins, and touches nothing else', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const friend = await api.friendWithLogin(tag('dismiss'))
      const token = await api.sessionFor(friend.id)
      const sub = tag('sub-dismiss')
      api.linkGoogle(friend.id, { sub, email: 'me@example.test' })

      const first = await api.dismissReq(friend.id, token)
      expect(first.status()).toBe(200)
      const raw = await first.text()
      expect(raw.match(STRIP_RE) || []).toEqual([])
      expect(JSON.parse(raw).googlePromptDismissed).toBe(true)
      expect(Number(api.row(friend.id).google_prompt_dismissed)).toBe(1)

      expect((await api.dismissReq(friend.id, token)).status(), 'idempotent').toBe(200)
      expect(Number(api.row(friend.id).google_prompt_dismissed)).toBe(1)

      // One-way by design: it is not a link write.
      const row = api.row(friend.id)
      expect(row.google_sub, 'the link is untouched').toBe(sub)
      expect(row.google_email).toBe('me@example.test')

      // ⚠ PERSISTS ACROSS LOGINS — a fresh login handshake reports it, which is what
      // UC-GA-006's prompt keys on (no extra request).
      const relogin = await api.passwordLogin(friend.username, friend.password)
      expect(relogin.status()).toBe(200)
      expect((await relogin.json()).googlePromptDismissed, 'a new login sees the flag').toBe(true)
    })
  })

  test('it has NO Google dependency — 200 on a deployment where link and unlink answer 503', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({ GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_TEST_MODE: '' }, async ({ api }) => {
      const friend = await api.plainFriend(tag('offdismiss'))
      const token = await api.sessionFor(friend.id)

      // ⚠ THE ASYMMETRY IS THE POINT (§UC-GA-004): dismissing a prompt is a local UI
      // preference, not a Google operation, so a deployment with the feature off must
      // still be able to record it. Both halves in ONE test so the pair cannot drift.
      expect((await api.linkReq(friend.id, token, { id_token: 'TEST:x:y@z.test' })).status(), 'link 503').toBe(503)
      expect((await api.unlinkReq(friend.id, token)).status(), 'unlink 503').toBe(503)
      const res = await api.dismissReq(friend.id, token)
      expect(res.status(), 'prompt-dismiss has no Google dependency').toBe(200)
      expect((await res.json()).googlePromptDismissed).toBe(true)
      expect(Number(api.row(friend.id).google_prompt_dismissed)).toBe(1)
    })
  })

  test('friend A cannot dismiss for friend B (403 both ways), and identity-less auth is 401', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api, ctx }) => {
      const a = await api.plainFriend(tag('da'))
      const b = await api.plainFriend(tag('db'))
      const aToken = await api.sessionFor(a.id)
      const bToken = await api.sessionFor(b.id)

      expect((await api.dismissReq(b.id, aToken)).status()).toBe(403)
      expect((await api.dismissReq(a.id, bToken)).status()).toBe(403)
      const shared = await ctx.post(`/api/friends/${a.id}/google-prompt-dismissed`, { headers: api.sharedPasswordHeaders() })
      expect(shared.status()).toBe(401)

      expect(Number(api.row(a.id).google_prompt_dismissed), 'nobody else could silence A').toBe(0)
      expect(Number(api.row(b.id).google_prompt_dismissed), 'nobody else could silence B').toBe(0)
    })
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// §UC-GA-004 — the SECOND layer of the dual-layer 409, exercised on its own
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠ WHY THIS NEEDS A SUBPROCESS PROBE AND CANNOT BE AN HTTP TEST.
//
// The handler's collision pre-check and its UPDATE are separated by NOTHING: the one
// `await` on the route (the verifier) happens BEFORE both, and better-sqlite3 is
// synchronous, so with `instances: 1` no request can interleave between them. The app
// pre-check is therefore what fires on every reachable path — the `SQLITE_CONSTRAINT`
// translation exists for the PM2-cluster scenario the CLAUDE.md concurrency note
// already warns about, and over HTTP it is UNREACHABLE BY CONSTRUCTION. An HTTP test
// asserting "409 on a taken sub" proves the pre-check and says nothing about the
// translation — which is exactly the GSO-T10 trap ("deleting the app check leaves the
// suite green").
//
// So the translation is exercised where it lives: `writeGoogleLink()` is imported from
// the REAL route module into a throwaway process, against a REAL migrated database with
// the REAL partial UNIQUE index, and called with a sub that is already taken — the
// pre-check never runs. It must RETURN the conflict, not throw, and the object it
// returns must be the exact body the route's pre-check branch answers with (they are
// one frozen constant, so the two layers cannot drift).
test.describe('§UC-GA-004 — the SQLITE_CONSTRAINT → 409 translation, without the app pre-check', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const SCHEMA_URL = 'file://' + join(REPO_ROOT, 'backend', 'src', 'db', 'schema.js')
  const FRIENDS_ROUTE_URL = 'file://' + join(REPO_ROOT, 'backend', 'src', 'routes', 'friends.js')
  const HAS_SOURCE = existsSync(join(REPO_ROOT, 'backend', 'src', 'routes', 'friends.js'))

  function probe(body) {
    const dir = mkdtempSync(join(tmpdir(), 'ga-t5-probe-'))
    const script = join(dir, 'probe.mjs')
    const dbFile = join(dir, 'probe.sqlite')
    writeFileSync(
      script,
      `import db from '${SCHEMA_URL}';\n` +
        `import { writeGoogleLink, GOOGLE_LINK_CONFLICT } from '${FRIENDS_ROUTE_URL}';\n` +
        `const out = (() => {\n${body}\n})();\n` +
        `console.log('@@PROBE@@' + JSON.stringify(out));\n`
    )
    try {
      const stdout = execFileSync(process.execPath, [script], {
        env: { ...process.env, DB_PATH: dbFile, GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_TEST_MODE: '' },
        encoding: 'utf8',
        cwd: REPO_ROOT,
      })
      const m = stdout.match(/@@PROBE@@(.*)/)
      if (!m) throw new Error(`probe produced no marker. stdout:\n${stdout}`)
      return JSON.parse(m[1])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a taken sub makes the UPDATE itself answer the conflict — returned, never thrown, and byte-identical to the pre-check 409', () => {
    test.skip(!CAN_SPAWN_BACKEND || !HAS_SOURCE, NEEDS_SOURCE)
    const out = probe(`
      db.exec('PRAGMA foreign_keys = OFF');
      db.run("INSERT INTO order_cycles (name) VALUES ('GA-T5 probe cycle')");
      const cyc = db.get('SELECT id FROM order_cycles ORDER BY id DESC LIMIT 1').id;
      db.run("INSERT INTO friends (name, cycle_id, access_token, google_sub, google_email) VALUES ('Holder', ?, 'ga5-holder', 'sub-taken', 'holder@example.test')", [cyc]);
      db.run("INSERT INTO friends (name, cycle_id, access_token) VALUES ('Other', ?, 'ga5-other')", [cyc]);
      const other = db.get("SELECT id FROM friends WHERE access_token = 'ga5-other'").id;

      const res = {};
      // The index really is there — otherwise every assertion below is vacuous.
      res.indexSql = (db.get("SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_friends_google_sub'") || {}).sql || null;

      // ⚠ NO PRE-CHECK. This is the call the route makes AFTER its own check has
      // passed — the PM2-cluster state where another process linked the sub in between.
      try {
        res.conflict = writeGoogleLink(other, 'sub-taken', 'other@example.test');
      } catch (e) {
        res.threw = { code: e && e.code, message: String(e && e.message) };
      }
      res.constant = GOOGLE_LINK_CONFLICT;
      res.otherRow = db.get('SELECT google_sub, google_email FROM friends WHERE id = ?', [other]);
      res.holderRow = db.get("SELECT google_sub, google_email FROM friends WHERE access_token = 'ga5-holder'");

      // Non-vacuity control: a FREE sub goes through the same function and writes.
      res.ok = writeGoogleLink(other, 'sub-free', 'other@example.test');
      res.otherAfter = db.get('SELECT google_sub, google_email FROM friends WHERE id = ?', [other]);
      return res;
    `)

    expect(out.indexSql, 'the partial UNIQUE index is the mechanism').toMatch(/UNIQUE INDEX/i)
    expect(out.threw, 'the constraint must be TRANSLATED, not propagated as a 500').toBeUndefined()
    expect(out.conflict, 'the write reports the conflict').toBeTruthy()
    expect(out.conflict.conflict, 'and carries the SAME frozen body the pre-check answers with').toEqual({
      error: LINK_CONFLICT,
      field: 'google',
    })
    expect(out.constant, 'one constant, two layers — they cannot drift').toEqual(out.conflict.conflict)

    // Nothing was written on the refused path, and the holder is untouched.
    expect(out.otherRow.google_sub).toBeNull()
    expect(out.otherRow.google_email).toBeNull()
    expect(out.holderRow.google_sub).toBe('sub-taken')
    expect(out.holderRow.google_email).toBe('holder@example.test')

    // …and the same function on a free sub really does write, so "conflict" above is
    // a decision, not a function that never works.
    expect(out.ok).toEqual({ ok: true })
    expect(out.otherAfter.google_sub).toBe('sub-free')
    expect(out.otherAfter.google_email).toBe('other@example.test')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GA-T6 — §UC-GA-006: the post-login link prompt (áno / teraz nie / už sa nepýtať)
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠⚠ THE ONE THING THIS BLOCK EXISTS TO PIN. The trigger is
// `googleLinked === false && googlePromptDismissed === false` — STRICT EQUALITY, never
// `!entry.googleLinked`. `POST /magic-link/redeem` deliberately does NOT publish either
// field (recorded at `magic-link.js:378`), and neither does the legacy shared-password
// branch of `POST /friends/auth`, so on those logins the fields are ABSENT. `!undefined`
// is `true` — a truthiness trigger would open the link prompt for a friend who is
// ALREADY LINKED, stacked on ML-T6's magic prompt, which is exactly the "one modal per
// login, maximum" §UC-GA-006 forbids. The omission is the ENFORCEMENT MECHANISM; the
// magic-link test below is the proof, and it is deliberately non-vacuous (it asserts the
// session really IS a magic-link session and the friend really IS unlinked and
// un-dismissed, so a `!entry.googleLinked` trigger cannot pass it).
//
// ⚠ A SECOND TERM THE SPEC DOES NOT STATE: `authMode === 'modern'`. GA-T5 put a
// modern-only guard on `PUT /:id/google-link` (409 `field:'auth_mode'`), so on a legacy
// deployment §UC-GA-006's literal condition would offer a link whose every attempt 409s.
// The spec predates that guard. Pinned by the transition-mode test, which flips the SAME
// backend to modern afterwards so the absence cannot be vacuous.
//
// Everything here runs on THROWAWAY BACKENDS serving their own copy of the SPA
// (`backend/public`) — the `magic-link.spec.js` precedent. The gate is pinned to legacy
// (`modern-login.spec.js` asserts nobody wrote `auth_mode`) and this prompt only exists
// in modern mode, so there is no way to test it on the shared server.

const PROMPT_TITLE = 'Prepojiť Google účet?'
const PROMPT_BODY = 'Nabudúce sa prihlásite jedným klikom, bez hesla.'
const PROMPT_YES = 'Áno, teraz'
const PROMPT_LATER = 'Teraz nie'
const PROMPT_NEVER = 'Už sa nepýtať'
const PROMPT_FOOTNOTE = 'Prepojenie nájdete kedykoľvek v profile.'

const PORTAL_HEADING = 'Objednávkové cykly'

/** Start a throwaway backend, put it in `mode`, and hand the test its API + a page. */
async function withPortal({ mode = 'modern', env = {} } = {}, fn) {
  await withGoogleBackend(env, async (bundle) => {
    if (mode !== 'legacy') await bundle.api.setAuthMode(mode)
    await fn(bundle)
  })
}

/** The modern login card's personal form. */
async function loginModern(page, backend, friend) {
  await page.goto(`${backend.baseUrl}/`)
  await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
  await page.getByLabel(/^heslo$/i).fill(friend.password)
  await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
}

const promptOf = (page) => page.getByTestId('google-link-prompt')

test.describe('§UC-GA-006 — the post-login Google link prompt', () => {
  test('a fresh modern password login of an unlinked friend opens it, with exactly the confirmed labels', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('prompt'))
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      // 320px: the narrowest supported width, and the one that matters here —
      // `.m-foot .btn` is `nowrap; flex:1` with no degradation signal (CLAUDE.md),
      // so a three-option footer that does not fit paints OUTSIDE the modal border
      // and nothing in the DOM says so.
      await page.setViewportSize({ width: 320, height: 800 })
      await loginModern(page, backend, friend)

      const prompt = promptOf(page)
      await expect(prompt).toBeVisible()
      await expect(page.getByRole('heading', { name: PROMPT_TITLE })).toBeVisible()
      await expect(prompt).toContainText(PROMPT_BODY)
      await expect(prompt).toContainText(PROMPT_FOOTNOTE)

      for (const label of [PROMPT_YES, PROMPT_LATER, PROMPT_NEVER]) {
        await expect(prompt.getByRole('button', { name: label, exact: true })).toBeVisible()
      }

      // The friend IS logged in behind it — the prompt is a prompt, not a gate.
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()

      // ⚠ One modal at a time: the credential-setup dialog and the forced gate must
      // not be up, and neither must a second copy of this one.
      await expect(prompt).toHaveCount(1)
      await expect(page.getByTestId('forced-password-change')).toHaveCount(0)

      // Geometry: every option inside the modal box, and no document overflow.
      const box = await prompt.boundingBox()
      for (const label of [PROMPT_YES, PROMPT_LATER, PROMPT_NEVER]) {
        const b = await prompt.getByRole('button', { name: label, exact: true }).boundingBox()
        expect(b.x, `${label} starts inside the modal`).toBeGreaterThanOrEqual(box.x - 0.5)
        expect(b.x + b.width, `${label} ends inside the modal`).toBeLessThanOrEqual(box.x + box.width + 0.5)
      }
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, 'the three-option footer must not scroll the page sideways').toBeLessThanOrEqual(0)
    })
  })

  test('"Teraz nie" closes it, writes NOTHING to the server, and the prompt returns at the next login', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('later'))
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      // Every write to the two prompt endpoints, counted. "Teraz nie" is
      // client-side ONLY (§UC-GA-006), so this must stay empty.
      const writes = []
      await page.route('**/api/friends/*/google-prompt-dismissed', (route) => {
        writes.push(route.request().url())
        return route.continue()
      })

      await loginModern(page, backend, friend)
      await expect(promptOf(page)).toBeVisible()
      await promptOf(page).getByRole('button', { name: PROMPT_LATER, exact: true }).click()
      await expect(promptOf(page)).toHaveCount(0)

      expect(writes, '"Teraz nie" makes no request').toEqual([])
      expect(api.row(friend.id).google_prompt_dismissed, 'and writes nothing to the DB').toBe(0)

      // ── the next login shows it again ──────────────────────────────────────
      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await loginModern(page, backend, friend)
      await expect(promptOf(page), 'a declined prompt returns at the next login').toBeVisible()
    })
  })

  test('"Už sa nepýtať" persists to the DB and silences the prompt for good', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('never'))
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await loginModern(page, backend, friend)
      await expect(promptOf(page)).toBeVisible()

      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-prompt-dismissed')),
        promptOf(page).getByRole('button', { name: PROMPT_NEVER, exact: true }).click(),
      ])
      expect(res.status(), 'the dismiss endpoint answers 200').toBe(200)
      await expect(promptOf(page)).toHaveCount(0)

      // ⚠ In the DB, not just in the response — the flag is the whole point.
      expect(api.row(friend.id).google_prompt_dismissed).toBe(1)
      expect(api.row(friend.id).google_sub, 'dismissing is not linking').toBeNull()

      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await loginModern(page, backend, friend)
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
      await expect(promptOf(page), 'a dismissed prompt never auto-opens again').toHaveCount(0)
    })
  })

  test('an ALREADY-LINKED friend never sees it — and neither does an already-dismissed one', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const linked = await api.friendWithLogin(tag('linked'))
      api.linkGoogle(linked.id, { sub: tag('sub-linked'), email: 'linked@example.test' })
      const dismissed = await api.friendWithLogin(tag('dsm'))
      api.linkGoogle(dismissed.id, { sub: null, dismissed: 1 })
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await loginModern(page, backend, linked)
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
      await expect(promptOf(page), 'googleLinked === true ⇒ nothing to offer').toHaveCount(0)

      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await loginModern(page, backend, dismissed)
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
      await expect(promptOf(page), 'googlePromptDismissed === true ⇒ silenced').toHaveCount(0)
    })
  })

  test('a MAGIC-LINK session shows no prompt, and neither does a session restore — the absent fields are the mechanism', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('magic'))
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      // ⚠ NON-VACUITY, asserted before anything else: this friend is UNLINKED and
      // UN-DISMISSED, so a `!entry.googleLinked` trigger WOULD fire here.
      const before = api.row(friend.id)
      expect(before.google_sub, 'the fixture is genuinely unlinked').toBeNull()
      expect(before.google_prompt_dismissed, 'and genuinely un-dismissed').toBe(0)

      // The session `MagicLogin.vue` produces: it reaches the portal by a ROUTE
      // change, so the stored payload is its only channel — `viaMagicLink` rides in,
      // and `googleLinked`/`googlePromptDismissed` cannot, because
      // `POST /magic-link/redeem` never publishes them. Reproduced by writing the
      // payload (the `magic-link.spec.js` precedent) rather than by standing up the
      // whole mail harness: the restore path is where the fields are absent, and
      // that is exactly what is under test.
      const session = await (await api.passwordLogin(friend.username, friend.password)).json()
      await page.goto(`${backend.baseUrl}/`)
      await page.evaluate((payload) => localStorage.setItem('gorifi_friend_auth', payload), JSON.stringify({
        friendId: friend.id,
        friendName: friend.name,
        friendUid: friend.uid,
        token: session.token,
        expiresAt: session.expiresAt,
        viaMagicLink: true,
      }))
      await page.goto(`${backend.baseUrl}/`)

      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
      await expect(
        page.getByTestId('magic-prompt'),
        'the session really IS a magic-link session — ML-T6\'s own prompt is on screen'
      ).toBeVisible()
      await expect(
        promptOf(page),
        'and the Google prompt must NOT stack on it: `!undefined` is the bug this pins'
      ).toHaveCount(0)

      // ── a plain RESTORE is not a login either ──────────────────────────────
      await page.evaluate(() => localStorage.removeItem('gorifi_friend_auth'))
      await page.goto(`${backend.baseUrl}/`)
      await loginModern(page, backend, friend)
      await expect(promptOf(page), 'the login itself does show it').toBeVisible()
      await promptOf(page).getByRole('button', { name: PROMPT_LATER, exact: true }).click()

      await page.reload()
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
      await expect(promptOf(page), 'a restore is not a login (§UC-GA-006)').toHaveCount(0)
    })
  })

  // ⚠ THE HALF `self-hosted-fonts.spec.js` CANNOT REACH, and the reason this test is
  // here rather than there (§UC-GA-012's route sweep says so in its own comment).
  //
  // GA-T6 makes `FriendPortalSession.vue` a SECOND sanctioned GIS importer. That is
  // safe only while the session view loads GIS from a user GESTURE and never on mount,
  // because the session is reachable at `/` with NO LOGIN CARD IN SIGHT — a token
  // restore, or `/magic/:token` succeeding and `router.replace('/')`-ing straight into
  // an authenticated portal. If the view ever called `loadGis()` during setup, that
  // path would contact Google with no card and no gesture, and the sweep's
  // `/magic/:token` zero would be holding only for the FAILURE token it happens to use.
  //
  // The sweep cannot see it: the shared gate is legacy (so the prompt cannot exist
  // there) and its visits are anonymous (so the session never mounts). Hence: modern
  // throwaway backend, both halves, measured with two different instruments.
  test('the session surface loads GIS only on a GESTURE — a session-only "/" contacts Google zero times', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('gesture'))

      // ── HALF 1: network. A session-only arrival, in a FRESH DOCUMENT. ──────────
      // `authState` starts at 'loading' and the restore branch never passes through
      // 'login', so the card's `showGoogleButton` is false for this whole document —
      // which is what makes the network instrument valid here: `lib/gis.js`'s module
      // singleton is also fresh, so ANY request to Google can only have come from the
      // session view mounting.
      const session = await (await api.passwordLogin(friend.username, friend.password)).json()
      let hits = await trackGoogle(page, { fulfilWith: GIS_STUB })
      await page.goto(`${backend.baseUrl}/`)

      // ⚠ LIVENESS of the instrument, and THE ORDERING IS LOAD-BEARING — this assertion
      // must complete BEFORE the payload is written, not after.
      //
      // `page.goto` resolves on `load`, while `FriendPortal`'s `onMounted` →
      // `loadInitialData()` is still pending. Seeding localStorage first therefore RACES
      // that read: win the race and the app restores a session immediately, the login
      // card never renders, and this first visit contacts Google zero times. The
      // original version of this test did exactly that — so `hits.length = 0` was a
      // no-op on an already-empty array and the `[]` below held trivially, proving
      // nothing. Waiting for the card's own GIS button is what pins the phase down: the
      // recorder is demonstrably wired up, and only then is a session introduced.
      await expect(page.getByTestId('gis-stub-button'),
        'the anonymous login card rendered and loaded GIS').toBeVisible()
      expect(hits.length, 'the recorder is live — the login card just used it')
        .toBeGreaterThan(0)

      await page.evaluate((payload) => localStorage.setItem('gorifi_friend_auth', payload), JSON.stringify({
        friendId: friend.id,
        friendName: friend.name,
        friendUid: friend.uid,
        token: session.token,
        expiresAt: session.expiresAt,
      }))
      hits.length = 0
      await page.goto(`${backend.baseUrl}/`)

      // Non-vacuity: the portal really rendered. "Zero requests" is otherwise
      // satisfied by a page that failed to mount at all.
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
      await expect(page.locator('.appbar')).toContainText(friend.name)
      await expect(page.getByTestId('google-signin'), 'the login card never rendered').toHaveCount(0)
      await page.waitForLoadState('networkidle')
      expect(hits,
        'a session-only "/" must contact Google zero times — this is the path a successful\n' +
        '/magic/:token lands on, and the guest-surface argument in self-hosted-fonts.spec.js\n' +
        'rests on it').toEqual([])

      // ── HALF 2: the stub's call record, which survives the loader's cache. ─────
      // On a FRESH login the card legitimately loads GIS, so no network assertion can
      // separate "the card loaded it" from "the session loaded it" — and `loadGis()`
      // is a module singleton, so a session-mount call would issue no request at all.
      // `renderButton` is the instrument that still sees it.
      await page.evaluate(() => localStorage.removeItem('gorifi_friend_auth'))
      await loginModern(page, backend, friend)
      await expect(promptOf(page)).toBeVisible()

      const targets = () => page.evaluate(
        () => window.__gisCalls.renderButton.map((c) => c.testid))
      expect(await targets(),
        'the prompt is on screen and UNTOUCHED — nothing may have rendered into it yet')
        .toEqual(['google-signin'])

      await promptOf(page).getByRole('button', { name: PROMPT_YES, exact: true }).click()
      await expect(promptOf(page).getByTestId('gis-stub-button')).toBeVisible()
      expect(await targets(), 'and the gesture is what puts a button in the modal')
        .toEqual(['google-signin', 'google-prompt-signin'])
    })
  })

  test('the trigger requires MODERN mode: the same friend gets nothing in transition and the prompt in modern', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({ mode: 'transition' }, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('trans'))
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      // Transition mode still runs the PERSONAL branch of `POST /friends/auth`, which
      // publishes `googleLinked: false, googlePromptDismissed: false` — so without the
      // `authMode === 'modern'` term this WOULD open, and it would offer a link that
      // GA-T5's guard answers 409 `field:'auth_mode'` to.
      await page.goto(`${backend.baseUrl}/`)
      await page.getByRole('button', { name: 'Osobné prihlásenie' }).click()
      await page.getByPlaceholder('Zadajte užívateľské meno').fill(friend.username)
      await page.getByPlaceholder('Zadajte heslo').fill(friend.password)
      await page.getByRole('button', { name: 'Prihlásiť sa' }).click()

      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
      await expect(promptOf(page), 'not modern ⇒ no link offer').toHaveCount(0)

      const handshake = await (await api.passwordLogin(friend.username, friend.password)).json()
      expect(handshake.googleLinked, 'the handshake really did say false…').toBe(false)
      expect(handshake.googlePromptDismissed, '…and false').toBe(false)

      // ── flip the SAME backend to modern: the absence above cannot be vacuous ──
      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await api.setAuthMode('modern')
      await loginModern(page, backend, friend)
      await expect(promptOf(page), 'modern ⇒ the very same friend is offered the link').toBeVisible()
    })
  })

  test('the legacy shared-password handshake carries neither field, so nothing can trigger on it', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    // The mirror of the magic-link rule at the API level: the shared-password branch is
    // identity-less honour-system auth, and it publishes no Google state at all. A
    // truthiness trigger would read `undefined` here too.
    await withPortal({ mode: 'legacy' }, async ({ ctx, api }) => {
      const friend = await api.plainFriend(tag('shared'))
      const res = await ctx.post('/api/friends/auth', { data: { password: FRIENDS_PASSWORD, friendId: friend.id } })
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body).not.toHaveProperty('googleLinked')
      expect(body).not.toHaveProperty('googlePromptDismissed')
    })
  })

  test('a blocking gate wins: a must_change_password login sees the forced gate and NO prompt, that login through', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('forcedui'), { keepForcedChange: true })
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await loginModern(page, backend, friend)
      const gate = page.getByTestId('forced-password-change')
      await expect(gate).toBeVisible()
      await expect(promptOf(page), 'one modal per login, maximum').toHaveCount(0)

      // ⚠ AND IT DOES NOT ARRIVE AFTERWARDS. §UC-GA-006: when a gate fired the prompt
      // "simply skips this login" — not "waits its turn".
      await gate.getByLabel(/^nové heslo$/i).fill('gatePass12345')
      await gate.getByLabel(/^potvrdiť nové heslo$/i).fill('gatePass12345')
      await gate.getByRole('button', { name: /Nastaviť heslo a pokračovať/ }).click()
      await expect(gate).toHaveCount(0)
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
      await expect(promptOf(page), 'the prompt skips this login entirely').toHaveCount(0)

      // The next login has no gate, so it does get the prompt — the absence above is
      // about the gate, not about this friend.
      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await loginModern(page, backend, { ...friend, password: 'gatePass12345' })
      await expect(promptOf(page)).toBeVisible()
    })
  })

  test('SESSION BOUNDARY: friend A declines, friend B logs in on the SAME page instance, B gets their own prompt', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    // ⚠ The six-leak surface, restated by §UC-GA-006 as a requirement. A declined-ref
    // that outlives the handshake — module scope, localStorage, or state keyed on the
    // friend id — silently suppresses the NEXT person's prompt.
    //
    // ⚠ NO DOCUMENT RELOAD ANYWHERE IN THIS TEST, in EITHER direction — that is the
    // whole point, and it is why the logins are inlined rather than routed through
    // `loginModern()`, whose first statement is a `page.goto()`. A reload rebuilds
    // module scope for free, so a leak that lives there would survive an A→B leg and
    // then be washed away before the B→A leg could see it. Both legs must run against
    // ONE document for the pair to mean anything.
    await withPortal({}, async ({ backend, api }) => {
      const alice = await api.friendWithLogin(tag('alice'))
      const bob = await api.friendWithLogin(tag('bob'))
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      // In-SPA login: fill the card that is already on screen, never navigate to it.
      const loginInPlace = async (friend) => {
        await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
        await page.getByLabel(/^heslo$/i).fill(friend.password)
        await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
      }

      // The ONLY navigation in this test.
      await page.goto(`${backend.baseUrl}/`)
      await loginInPlace(alice)
      await expect(promptOf(page)).toBeVisible()
      await promptOf(page).getByRole('button', { name: PROMPT_LATER, exact: true }).click()
      await expect(promptOf(page)).toHaveCount(0)

      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await loginInPlace(bob)

      await expect(page.locator('.appbar')).toContainText(bob.name)
      await expect(promptOf(page), "Alice's decision must not reach Bob").toBeVisible()

      // …and back the other way, still in the same document: Bob dismissing must not
      // re-arm — or re-silence — Alice.
      await promptOf(page).getByRole('button', { name: PROMPT_LATER, exact: true }).click()
      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await loginInPlace(alice)
      await expect(page.locator('.appbar')).toContainText(alice.name)
      await expect(promptOf(page), 'each handshake owns its own decision').toBeVisible()
    })
  })

  test('"Áno, teraz" swaps the body to the GIS button and links the account', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('link'))
      const sub = tag('sub-prompt')
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await loginModern(page, backend, friend)
      await expect(promptOf(page)).toBeVisible()

      const initBefore = (await page.evaluate(() => window.__gisCalls.initialize)).length
      await promptOf(page).getByRole('button', { name: PROMPT_YES, exact: true }).click()

      // The body swaps to the GIS mount — and the offer is gone from it, so there is
      // no way to fire the same flow twice from one modal.
      await expect(promptOf(page).getByTestId('google-prompt-signin')).toBeVisible()
      await expect(promptOf(page).getByTestId('gis-stub-button')).toBeVisible()
      await expect(promptOf(page).getByRole('button', { name: PROMPT_YES, exact: true })).toHaveCount(0)

      const calls = await page.evaluate(() => window.__gisCalls)
      expect(calls.initialize.length, 'the prompt registers its OWN callback').toBe(initBefore + 1)
      expect(calls.initialize.at(-1).client_id, 'the served client id').toBe(TEST_CLIENT_ID)
      expect(calls.renderButton.at(-1).testid, 'rendered into the modal\'s own container')
        .toBe('google-prompt-signin')

      // The e2e boundary (§UC-GA-013): fire a credential at whoever owns the callback.
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        page.evaluate((token) => window.__gisCallback({ credential: token }), `TEST:${sub}:me@example.test`),
      ])
      expect(res.status(), 'the link succeeds').toBe(200)
      expect(res.request().method()).toBe('PUT')

      await expect(promptOf(page).getByTestId('google-prompt-linked')).toContainText('me@example.test')

      const row = api.row(friend.id)
      expect(row.google_sub, 'the link is written').toBe(sub)
      expect(row.google_email).toBe('me@example.test')
      expect(row.google_prompt_dismissed, 'linking is not dismissing (§UC-GA-004)').toBe(0)

      // ── and the login card takes its callback back ────────────────────────
      // ⚠ `google.accounts.id.initialize()` registers ONE GLOBAL callback. The prompt
      // re-registered it, so without a reset the login card after a logout would hand
      // Google's credential to an UNMOUNTED component and the Google button would be
      // silently dead. Nothing else in the suite can see this.
      await promptOf(page).getByRole('button', { name: 'Zatvoriť dialóg' }).click()
      await expect(promptOf(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await expect(page.getByTestId('google-signin')).toBeVisible()
      await expect
        .poll(async () => (await page.evaluate(() => window.__gisCalls.initialize)).length,
          { message: 'the login card re-registers its own GIS callback after a session used one' })
        .toBeGreaterThan(initBefore + 1)

      // Proof rather than inference: the callback the login card now owns really is a
      // LOGIN callback — firing it signs the (now linked) friend straight in.
      await page.evaluate((token) => window.__gisCallback({ credential: token }), `TEST:${sub}:me@example.test`)
      await expect(page.locator('.appbar')).toContainText(friend.name)
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()

      // ⚠ "NEVER FOR A GOOGLE LOGIN" (§UC-GA-006) — the one trigger branch that had no
      // assertion of its own. The two lines above do NOT cover it: the portal heading
      // and the appbar stay `visible` behind a NeoModal scrim, so a prompt that DID
      // open would leave both green. `onGoogleCredential()` passes no Google fields to
      // `beginSession()`, so the trigger reads `undefined` — the same structural
      // mechanism the magic-link test pins, and it deserves the same assertion.
      await expect(
        promptOf(page),
        'a Google login is already linked — offering to link it is the absurd case'
      ).toHaveCount(0)
    })
  })

  // ⚠ The one user-visible string in this row that no other test reaches, on a branch a
  // real friend hits whenever Google is blocked, offline or behind a captive portal.
  // The message is half of it; the RECOVERY is the load-bearing half — the stage must
  // fall back to 'ask' so the three options are on screen again, or the friend is left
  // in a modal whose only content is an error and whose GIS box will never fill.
  test('a blocked GIS shows the loader-failure sentence and returns the modal to its three options', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('gisdown'))

      // ⚠ Google is aborted for the WHOLE document, from the first byte — the honest
      // reproduction of a blocked/offline/captive-portal client, and the only way to
      // reach the catch without touching internals. `loadGis` memoises a SUCCESSFUL
      // load in module scope (`namespace()` short-circuits before `pending`), so had
      // the login card loaded the stub first, the prompt's call would return the cached
      // namespace and never fail. It memoises a FAILURE differently — `fail()` sets
      // `pending = null` — which is exactly what lets the prompt genuinely retry here
      // and fail on its own. The card's own silent degradation (documented in
      // `renderGoogleButton`) is what still lets the friend log in with a password.
      const hits = await trackGoogle(page)
      await loginModern(page, backend, friend)
      await expect(promptOf(page), 'the prompt needs only googleClientId, never GIS').toBeVisible()
      expect(hits.length, 'the card really did try Google, and really was refused')
        .toBeGreaterThan(0)

      await promptOf(page).getByRole('button', { name: PROMPT_YES, exact: true }).click()

      await expect(promptOf(page), 'the sentence the friend actually sees')
        .toContainText('Google sa nepodarilo načítať. Skúste to prosím neskôr.')
      // The recovery: back to 'ask', so the modal is usable rather than a dead end.
      await expect(promptOf(page).getByTestId('google-prompt-signin'),
        'the empty GIS box is gone').toHaveCount(0)
      for (const label of [PROMPT_YES, PROMPT_LATER, PROMPT_NEVER]) {
        await expect(promptOf(page).getByRole('button', { name: label, exact: true }),
          `${label} is back — the modal returned to its three options`).toBeVisible()
      }
      // And nothing was written on a path that never reached the server.
      expect(api.row(friend.id).google_sub).toBeNull()
      expect(api.row(friend.id).google_prompt_dismissed).toBe(0)
    })
  })

  test('a 409 renders inline in the modal, the modal stays open, and nothing is written', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const holder = await api.plainFriend(tag('holder'))
      const sub = tag('sub-taken')
      api.linkGoogle(holder.id, { sub, email: 'holder@example.test' })
      const friend = await api.friendWithLogin(tag('collide'))
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await loginModern(page, backend, friend)
      await promptOf(page).getByRole('button', { name: PROMPT_YES, exact: true }).click()
      await expect(promptOf(page).getByTestId('gis-stub-button')).toBeVisible()

      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        page.evaluate((token) => window.__gisCallback({ credential: token }), `TEST:${sub}:thief@example.test`),
      ])
      expect(res.status()).toBe(409)

      // Verbatim from §UC-GA-004, and it names no friend — ever.
      await expect(promptOf(page)).toContainText(LINK_CONFLICT)
      await expect(promptOf(page), 'no information about WHICH friend').not.toContainText(holder.name)
      await expect(promptOf(page), 'the modal stays open — no retry loop, no auto-close').toBeVisible()

      expect(api.row(friend.id).google_sub, 'nothing was written for the loser').toBeNull()
      expect(api.row(holder.id).google_sub, 'and the holder is untouched').toBe(sub)
    })
  })

  test('an UNCONFIGURED deployment shows no prompt and makes zero requests to Google', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    // ⚠ `GOOGLE_CLIENT_ID: ''` — `startBackend` blanks it and this keeps it blank, so
    // `auth-mode` reports `googleClientId: null` for real. Not a `page.route` stub: this
    // is the deployment state §UC-GA-002 describes, observed end to end.
    await withPortal({ env: { GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_TEST_MODE: '' } }, async ({ backend, ctx, api }) => {
      expect((await (await ctx.get('/api/friends/auth-mode')).json()).googleClientId).toBeNull()
      const friend = await api.friendWithLogin(tag('noconf'))
      const hits = await trackGoogle(page)

      await loginModern(page, backend, friend)
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
      await expect(promptOf(page)).toHaveCount(0)
      await page.waitForLoadState('networkidle')
      expect(hits, 'an unconfigured deployment must be Google-free').toEqual([])
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GA-T7 — §UC-GA-007: the profile modal's Google section (manual link / unlink)
// ═════════════════════════════════════════════════════════════════════════════
//
// The always-available manual trigger the brief asks for. Everything here runs on
// THROWAWAY BACKENDS serving their own copy of the SPA, for the same two reasons the
// GA-T6 block above states: the section is modern-mode only and the gate is pinned to
// legacy, and a pre-existing link is a direct column write.
//
// ⚠ THREE CONSTRAINTS THIS BLOCK EXISTS TO PIN, none of them in §UC-GA-007's own text:
//
//  1. `gis.initialize()` is called UNCONDITIONALLY before this section's
//     `renderButton`, never behind an "already initialised" flag. GIS keeps ONE GLOBAL
//     callback and the §UC-GA-006 prompt, this section and the login card can all
//     exist within one session — whichever rendered LAST owns it. GA-T6 found the live
//     version of this: the prompt re-registered the callback and the login card's
//     guard then skipped `initialize`, so its button rendered perfectly and did
//     nothing. Counting calls is NOT proof; the proof is FIRING a credential at the
//     other surface's callback and watching where the answer lands.
//
//  2. The mode gate is on the LINK half, not on the section. GA-T5 put a modern-only
//     guard on `PUT /:id/google-link` (409 `field:'auth_mode'`), so §UC-GA-007's
//     literal "googleClientId alone" would ship a GIS button whose every attempt 409s
//     on a legacy or transition deployment. But `DELETE /:id/google-link` has NO mode
//     guard, so gating the whole section would ALSO strip a linked friend's
//     self-service unlink there — a capability the spec grants and the server honours,
//     reachable whenever a deployment rolls modern back to transition. Two tests pin
//     the pair: the unlinked friend gets nothing in transition, the linked one keeps
//     the section and really does unlink. §UC-GA-007 is amended to match.
//
//  3. The no-password warning. §UC-GA-007 keys it on `hasCredentials === false` — and
//     the affordance that value gates elsewhere (the CHANGE-password fold) is HIDDEN
//     when it is false, so such a friend has no on-screen path to set a password at
//     all. GA-T7 ships the WARNING, which tells the truth §UC-GA-004 states (the admin
//     reset is the recovery path); building a set-a-password flow is a follow-up row,
//     not this one. The absence of the fold is asserted below so the follow-up has a
//     pin to delete.
//
// ⚠ SESSION BOUNDARY (§UC-GA-006, which §UC-GA-007 says applies identically): the
// section's state is a per-instance ref seeded from the handshake, and the last test
// here runs BOTH leak directions (a true override reaching an unlinked friend, a false
// one reaching a linked friend) in ONE document with no reload.

const GOOGLE_SECTION_HELPER = 'Prepojte si Google účet a prihlasujte sa jedným klikom.'
const GOOGLE_LINKED_FALLBACK = 'Prepojené'
const GOOGLE_UNLINK = 'Odpojiť Google účet'
const GOOGLE_UNLINK_CONFIRM = 'Áno, odpojiť'
const GOOGLE_UNLINK_CANCEL = 'Nechať prepojené'
const GOOGLE_UNLINK_QUESTION = 'Naozaj chcete odpojiť Google účet?'
const NO_PASSWORD_WARNING =
  'Bez hesla sa nebudete môcť prihlásiť, kým vám správca nenastaví nové heslo.'

const sectionOf = (page) => page.getByTestId('profile-google')

/**
 * Open the profile modal from the appbar and return the section (never the dialog).
 *
 * ⚠ The portal heading FIRST. `.appbar .titles` exists on the login card too — it reads
 * "Členský vstup" there and its `titles-action` is empty, so clicking it while a login
 * is still in flight silently does nothing and the failure surfaces ten seconds later
 * as "no .m-title", which looks like a broken modal rather than a race.
 */
async function openProfileSection(page) {
  await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
  await page.locator('.appbar .titles').click()
  await expect(page.getByRole('dialog').locator('.m-title')).toHaveText('Upraviť profil')
  return sectionOf(page)
}

/** The §UC-GA-013 boundary: hand a credential to whoever owns GIS's ONE callback. */
function fireCredential(page, token) {
  return page.evaluate((t) => window.__gisCallback({ credential: t }), token)
}

test.describe('§UC-GA-007 — the profile modal Google section', () => {
  test('an unlinked friend links from the profile and the section flips in place — no reload, no prompt flag touched', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('psec'))
      const sub = tag('sub-profile')
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await loginModern(page, backend, friend)
      // The §UC-GA-006 prompt is a different surface; decline it so what follows is
      // unambiguously the profile's own section.
      await promptOf(page).getByRole('button', { name: PROMPT_LATER, exact: true }).click()
      await expect(promptOf(page)).toHaveCount(0)

      const initBefore = (await page.evaluate(() => window.__gisCalls.initialize)).length
      const section = await openProfileSection(page)

      await expect(section).toBeVisible()
      await expect(section).toContainText(GOOGLE_SECTION_HELPER)
      await expect(section.getByRole('button', { name: GOOGLE_UNLINK, exact: true })).toHaveCount(0)
      await expect(section.getByTestId('gis-stub-button')).toBeVisible()

      const calls = await page.evaluate(() => window.__gisCalls)
      expect(calls.initialize.length, 'the section registers its OWN callback').toBe(initBefore + 1)
      expect(calls.initialize.at(-1).client_id).toBe(TEST_CLIENT_ID)
      expect(calls.initialize.at(-1).hasCallback).toBe(true)
      expect(calls.renderButton.at(-1).testid, 'into the section\'s own container')
        .toBe('google-profile-signin')

      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        fireCredential(page, `TEST:${sub}:profile@example.test`),
      ])
      expect(res.status()).toBe(200)
      expect(res.request().method()).toBe('PUT')

      // Flipped IN PLACE: same modal, same document.
      await expect(section.getByTestId('profile-google-email')).toHaveText('profile@example.test')
      await expect(section.getByRole('button', { name: GOOGLE_UNLINK, exact: true })).toBeVisible()
      await expect(section.getByTestId('google-profile-signin'), 'the offer is gone once taken')
        .toHaveCount(0)
      await expect(section).not.toContainText(GOOGLE_SECTION_HELPER)

      const row = api.row(friend.id)
      expect(row.google_sub).toBe(sub)
      expect(row.google_email).toBe('profile@example.test')
      expect(row.google_prompt_dismissed, 'linking here is not dismissing (§UC-GA-007)').toBe(0)

      // The pre-existing modal is untouched around it (the additive requirement).
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('button', { name: 'Zmeniť heslo' })).toBeVisible()
      await expect(dialog.locator('#pp-profile-name')).toBeVisible()

      // Closing and reopening the modal keeps the new state — it is session state, not
      // modal state, and nothing here reloaded the document.
      await dialog.getByRole('button', { name: 'Zrušiť' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      const again = await openProfileSection(page)
      await expect(again.getByRole('button', { name: GOOGLE_UNLINK, exact: true })).toBeVisible()
    })
  })

  test('a link with no stored address reads "Prepojené" — the section never renders an empty line', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('noaddr'))
      api.linkGoogle(friend.id, { sub: tag('sub-noaddr'), email: null })
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await loginModern(page, backend, friend)
      const section = await openProfileSection(page)
      await expect(promptOf(page), 'a linked friend is never prompted').toHaveCount(0)
      await expect(section.getByTestId('profile-google-email')).toHaveText(GOOGLE_LINKED_FALLBACK)
      await expect(section.getByRole('button', { name: GOOGLE_UNLINK, exact: true })).toBeVisible()
    })
  })

  test('unlink: confirm → DELETE → the section flips back with a FRESH GIS button, and a friend WITH a password gets no warning', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('unl'))
      const sub = tag('sub-unlink')
      api.linkGoogle(friend.id, { sub, email: 'unl@example.test' })
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await loginModern(page, backend, friend)
      const section = await openProfileSection(page)
      await expect(section.getByTestId('profile-google-email')).toHaveText('unl@example.test')

      // ── the confirm, and the ABSENCE half of the no-password rule ──────────
      await section.getByRole('button', { name: GOOGLE_UNLINK, exact: true }).click()
      await expect(section).toContainText(GOOGLE_UNLINK_QUESTION)
      await expect(section, 'this friend HAS a password — no warning may appear')
        .not.toContainText(NO_PASSWORD_WARNING)

      // Backing out writes nothing.
      await section.getByRole('button', { name: GOOGLE_UNLINK_CANCEL, exact: true }).click()
      await expect(section.getByTestId('profile-google-email')).toHaveText('unl@example.test')
      expect(api.row(friend.id).google_sub, 'a cancelled confirm is not a request').toBe(sub)

      const initBefore = (await page.evaluate(() => window.__gisCalls.initialize)).length
      await section.getByRole('button', { name: GOOGLE_UNLINK, exact: true }).click()
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        section.getByRole('button', { name: GOOGLE_UNLINK_CONFIRM, exact: true }).click(),
      ])
      expect(res.status()).toBe(200)
      expect(res.request().method()).toBe('DELETE')

      await expect(section).toContainText(GOOGLE_SECTION_HELPER)
      await expect(section.getByRole('button', { name: GOOGLE_UNLINK, exact: true })).toHaveCount(0)
      // ⚠ A FRESH button, freshly initialised: the section is usable again without a
      // reload, and it takes GIS's global callback back on the way.
      await expect(section.getByTestId('gis-stub-button')).toBeVisible()
      await expect
        .poll(async () => (await page.evaluate(() => window.__gisCalls.initialize)).length,
          { message: 'the re-rendered button re-registers the callback' })
        .toBeGreaterThan(initBefore)

      const row = api.row(friend.id)
      expect(row.google_sub).toBeNull()
      expect(row.google_email).toBeNull()
      expect(row.google_prompt_dismissed, 'unlinking is not un-dismissing (§UC-GA-007)').toBe(0)
      await expect(section, 'a friend WITH a password is never warned, before or after')
        .not.toContainText(NO_PASSWORD_WARNING)
    })
  })

  test('the no-password warning appears exactly when hasCredentials is false — in the confirm AND after the unlink', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({}, async ({ backend, api }) => {
      // A friend whose ONLY login is Google — no username, no password_hash. They can
      // only get into the portal the way a real one does: the login card's Google
      // button. That is also the only realistic way to reach this state in modern mode.
      const friend = await api.plainFriend(tag('nopass'))
      const sub = tag('sub-nopass')
      api.linkGoogle(friend.id, { sub, email: 'nopass@example.test' })
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await page.goto(`${backend.baseUrl}/`)
      await expect(page.getByTestId('google-signin')).toBeVisible()
      await fireCredential(page, `TEST:${sub}:nopass@example.test`)
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()

      const section = await openProfileSection(page)
      // ⚠ THE MISSING AFFORDANCE, pinned as an absence (constraint 3 above): this
      // friend has no password, the change-password fold is keyed on `hasCredentials`
      // and therefore hidden, and NOTHING replaces it — the profile offers no way to
      // set a first password. Delete this assertion when the follow-up row lands.
      //
      // ⚠ Asserted as "no password control AT ALL", not as the absence of the string
      // "Zmeniť heslo". That narrower form would (a) merely duplicate
      // `portal-profile-modal.spec.js:265`, same locator and same condition, and
      // (b) FAIL TO DETECT THE GAP CLOSING: a first-password affordance would be
      // labelled "Nastaviť heslo", so it would sail straight past a check that only
      // looks for "Zmeniť". `/heslo/i` catches both, and anything else somebody names
      // it in Slovak.
      const passwordControls = page.getByRole('dialog').getByRole('button', { name: /heslo/i })
      await expect(passwordControls,
        'a credential-less friend has NO password-setting control in the profile')
        .toHaveCount(0)

      await expect(section.getByTestId('profile-google-email')).toHaveText('nopass@example.test')
      await section.getByRole('button', { name: GOOGLE_UNLINK, exact: true }).click()
      await expect(section, 'the client already knows hasCredentials is false')
        .toContainText(NO_PASSWORD_WARNING)

      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        section.getByRole('button', { name: GOOGLE_UNLINK_CONFIRM, exact: true }).click(),
      ])
      expect(res.status()).toBe(200)
      expect((await res.json()).warning, 'GA-T5 ships the server half').toBe('no_password')

      // The unlink HAPPENS (the friend's own account, §UC-GA-004) — and the warning
      // stays on screen afterwards, now backed by the endpoint's own answer.
      await expect(section).toContainText(GOOGLE_SECTION_HELPER)
      await expect(section.getByTestId('profile-google-warning')).toContainText(NO_PASSWORD_WARNING)
      expect(api.row(friend.id).google_sub).toBeNull()
    })
  })

  test('⚠ a Google login seeds googleLinked from the HANDSHAKE: a failed profile fetch cannot offer to link the account you just signed in with', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    // ⚠ `hydrateCurrentFriend()` is fire-and-forget and documented as allowed to fail
    // silently, so on the ONE login path where the friend is definitionally linked the
    // section must not depend on it. Before `onGoogleCredential()` passed
    // `googleLinked: true` into `beginSession()`, a failed profile fetch left this
    // friend looking UNLINKED for the whole session: a GIS button offering to link the
    // account they had just logged in with, no unlink affordance at all, and — because
    // `hasCredentials` IS seeded immediately from the login response — the "Bez hesla
    // sa nebudete môcť prihlásiť" banner, which is FALSE for them; they can still log
    // in with Google.
    await withPortal({}, async ({ backend, api }) => {
      const friend = await api.plainFriend(tag('hydratefail'))
      const sub = tag('sub-hydratefail')
      api.linkGoogle(friend.id, { sub, email: 'hydrate@example.test' })
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      // The failure, reproduced honestly: the owner-scoped profile GET never lands.
      await page.route('**/api/friends/*/profile', (route) => (
        route.request().method() === 'GET' ? route.abort() : route.continue()
      ))

      await page.goto(`${backend.baseUrl}/`)
      await expect(page.getByTestId('google-signin')).toBeVisible()
      await fireCredential(page, `TEST:${sub}:hydrate@example.test`)

      const section = await openProfileSection(page)
      // Linked, from the handshake alone. No address is available (the handshake
      // publishes `googleLinked` only, §UC-GA-003), so the NULL-email fallback is
      // exactly the right thing to render.
      await expect(section.getByTestId('profile-google-email')).toHaveText(GOOGLE_LINKED_FALLBACK)
      await expect(section.getByRole('button', { name: GOOGLE_UNLINK, exact: true })).toBeVisible()
      await expect(section, 'never offer to link what this very login used')
        .not.toContainText(GOOGLE_SECTION_HELPER)
      await expect(section.getByTestId('google-profile-signin')).toHaveCount(0)
      await expect(section.getByTestId('profile-google-warning'),
        'the no-password banner is FALSE while the Google link is live').toHaveCount(0)

      // ⚠ And §UC-GA-006 does not move: `true !== false`, so the prompt stays shut on
      // this path exactly as it did when the field was absent.
      await expect(promptOf(page), 'a Google login is already linked').toHaveCount(0)
    })
  })

  test('⚠ UNCONDITIONAL gis.initialize(): the section takes the ONE global callback from the prompt, and the login card takes it back', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(180_000)

    await withPortal({}, async ({ backend, api }) => {
      // A sub already held by somebody else, so the credential this test fires produces
      // a 409 — the ONLY observable that distinguishes WHICH surface's callback ran,
      // because the two callbacks render their error in different places.
      const holder = await api.plainFriend(tag('holder7'))
      const takenSub = tag('sub-taken7')
      api.linkGoogle(holder.id, { sub: takenSub, email: 'holder7@example.test' })
      const friend = await api.friendWithLogin(tag('own7'))
      const mySub = tag('sub-own7')
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await loginModern(page, backend, friend)

      // ── 1. the PROMPT registers the callback ──────────────────────────────
      await promptOf(page).getByRole('button', { name: PROMPT_YES, exact: true }).click()
      await expect(promptOf(page).getByTestId('gis-stub-button')).toBeVisible()
      const afterPrompt = (await page.evaluate(() => window.__gisCalls.initialize)).length
      await promptOf(page).getByRole('button', { name: 'Zatvoriť dialóg' }).click()
      await expect(promptOf(page)).toHaveCount(0)

      // ── 2. the SECTION must take it, unconditionally ──────────────────────
      const section = await openProfileSection(page)
      await expect(section.getByTestId('gis-stub-button')).toBeVisible()
      const calls = await page.evaluate(() => window.__gisCalls)
      expect(calls.initialize.length,
        'a guard flag here would skip initialize and leave the prompt owning the callback')
        .toBe(afterPrompt + 1)
      expect(calls.renderButton.at(-1).testid).toBe('google-profile-signin')

      // ⚠ THE PROOF, and it is not a call count. Fire a colliding credential: if the
      // closed prompt still owned the callback, its 409 would render into an unmounted
      // modal and this section would show nothing at all.
      const [conflict] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        fireCredential(page, `TEST:${takenSub}:thief@example.test`),
      ])
      expect(conflict.status()).toBe(409)
      await expect(page.getByRole('dialog'), 'the 409 lands in the modal\'s existing error slot')
        .toContainText(LINK_CONFLICT)
      await expect(promptOf(page), 'the prompt is gone — it cannot be the one that answered')
        .toHaveCount(0)
      await expect(page.getByRole('dialog'), 'and it names no friend').not.toContainText(holder.name)

      // The section still works after the refusal.
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        fireCredential(page, `TEST:${mySub}:own7@example.test`),
      ])
      await expect(section.getByTestId('profile-google-email')).toHaveText('own7@example.test')

      // ── 3. the LOGIN CARD takes it back when it re-renders ────────────────
      await page.getByRole('dialog').getByRole('button', { name: 'Zrušiť' }).click()
      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await expect(page.getByTestId('google-signin')).toBeVisible()
      await expect
        .poll(async () => (await page.evaluate(() => window.__gisCalls.initialize)).length,
          // `calls.initialize.length` already INCLUDES the section's own registration
          // (it was read after it), so "one more than that" is the card's.
          { message: 'the login card re-registers after a session used the callback' })
        .toBeGreaterThan(calls.initialize.length)

      // Proof rather than inference: the callback it now owns is a LOGIN callback.
      await fireCredential(page, `TEST:${mySub}:own7@example.test`)
      await expect(page.locator('.appbar')).toContainText(friend.name)
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()
    })
  })

  test('SESSION BOUNDARY: a link and an unlink made in one session reach neither the next friend nor the one after', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(180_000)

    // ⚠ BOTH leak directions, in ONE document, with NO reload anywhere — a reload
    // rebuilds module scope for free and would wash a leak away before the second leg
    // could see it. Direction 1: A links (a TRUE override) and B, who is unlinked, must
    // still be offered the button. Direction 2: B links then unlinks (a FALSE override)
    // and A, who really is linked, must still read linked.
    await withPortal({}, async ({ backend, api }) => {
      const a = await api.friendWithLogin(tag('boundA'))
      const b = await api.friendWithLogin(tag('boundB'))
      const subA = tag('sub-boundA')
      const subB = tag('sub-boundB')
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      const loginInPlace = async (friend) => {
        await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
        await page.getByLabel(/^heslo$/i).fill(friend.password)
        await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
      }
      const declinePrompt = async () => {
        await promptOf(page).getByRole('button', { name: PROMPT_LATER, exact: true }).click()
        await expect(promptOf(page)).toHaveCount(0)
      }
      const closeModal = async () => {
        await page.getByRole('dialog').getByRole('button', { name: 'Zrušiť' }).click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
      }

      // The ONLY navigation in this test.
      await page.goto(`${backend.baseUrl}/`)

      // A links from their profile.
      await loginInPlace(a)
      await declinePrompt()
      let section = await openProfileSection(page)
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        fireCredential(page, `TEST:${subA}:a@example.test`),
      ])
      await expect(section.getByTestId('profile-google-email')).toHaveText('a@example.test')
      await closeModal()

      // ── direction 1: A's TRUE state must not reach B, who is unlinked ─────
      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await loginInPlace(b)
      await expect(page.locator('.appbar')).toContainText(b.name)
      await declinePrompt()
      section = await openProfileSection(page)
      await expect(section, "A's link must not reach B").toContainText(GOOGLE_SECTION_HELPER)
      await expect(section.getByRole('button', { name: GOOGLE_UNLINK, exact: true })).toHaveCount(0)
      await expect(section.getByTestId('profile-google-email')).toHaveCount(0)

      // B links, then unlinks — a FALSE override in this session.
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        fireCredential(page, `TEST:${subB}:b@example.test`),
      ])
      await expect(section.getByTestId('profile-google-email')).toHaveText('b@example.test')
      await section.getByRole('button', { name: GOOGLE_UNLINK, exact: true }).click()
      await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        section.getByRole('button', { name: GOOGLE_UNLINK_CONFIRM, exact: true }).click(),
      ])
      await expect(section).toContainText(GOOGLE_SECTION_HELPER)
      await closeModal()

      // ── direction 2: B's FALSE state must not reach A, who IS linked ──────
      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await loginInPlace(a)
      await expect(page.locator('.appbar')).toContainText(a.name)
      await expect(promptOf(page), 'A is linked now — no prompt').toHaveCount(0)
      section = await openProfileSection(page)
      await expect(section.getByTestId('profile-google-email'), "B's unlink must not reach A")
        .toHaveText('a@example.test')
      await expect(section, 'and no offer to link what is already linked')
        .not.toContainText(GOOGLE_SECTION_HELPER)

      expect(api.row(a.id).google_sub, 'the server agrees with A').toBe(subA)
      expect(api.row(b.id).google_sub, 'and with B').toBeNull()
    })
  })

  test('⚠ but UNLINK is not mode-gated: a LINKED friend on a transition deployment still severs it', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    // ⚠ THE ASYMMETRY, and why the gate is on the link half only. GA-T5's
    // `field:'auth_mode'` 409 guards `PUT /:id/google-link` and NOTHING else —
    // `DELETE /:id/google-link` has no mode guard and works on every deployment. A
    // deployment that rolls modern back to transition after friends have linked would,
    // under a section-wide mode gate, silently strip those friends of the self-service
    // unlink §UC-GA-007 grants them and the server still honours.
    await withPortal({ mode: 'transition' }, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('translinked'))
      const sub = tag('sub-translinked')
      api.linkGoogle(friend.id, { sub, email: 'trans@example.test' })
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await page.goto(`${backend.baseUrl}/`)
      await page.getByRole('button', { name: 'Osobné prihlásenie' }).click()
      await page.getByPlaceholder('Zadajte užívateľské meno').fill(friend.username)
      await page.getByPlaceholder('Zadajte heslo').fill(friend.password)
      await page.getByRole('button', { name: 'Prihlásiť sa' }).click()

      const section = await openProfileSection(page)
      await expect(section, 'a linked friend keeps the section outside modern mode').toBeVisible()
      await expect(section.getByTestId('profile-google-email')).toHaveText('trans@example.test')
      // …but no OFFER: the helper line and the GIS mount belong to the link half.
      await expect(section).not.toContainText(GOOGLE_SECTION_HELPER)
      await expect(section.getByTestId('google-profile-signin')).toHaveCount(0)

      await section.getByRole('button', { name: GOOGLE_UNLINK, exact: true }).click()
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/google-link')),
        section.getByRole('button', { name: GOOGLE_UNLINK_CONFIRM, exact: true }).click(),
      ])
      expect(res.status(), 'DELETE has no mode guard').toBe(200)
      expect(api.row(friend.id).google_sub).toBeNull()

      // And once unlinked, the section withdraws entirely on this deployment — there
      // is nothing left to show and no link it could honestly offer.
      await expect(sectionOf(page), 'no bare heading over an offer that would 409')
        .toHaveCount(0)
      await expect(page.getByRole('dialog').locator('#pp-profile-name'),
        'non-vacuity: the rest of the modal is still there').toBeVisible()
    })
  })

  test('the section requires MODERN mode: absent in transition, present on the same backend once flipped', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    // ⚠ Constraint 2 above, in its NARROWED form. §UC-GA-007 says "rendered only when
    // googleClientId is non-null" — full stop — but GA-T5's modern-only guard on PUT
    // /:id/google-link means the spec's literal condition ships a button whose every
    // attempt 409s. This test is the UNLINKED friend, for whom the section is entirely
    // an offer; the test above is the linked one, who keeps it. The two together are
    // what pin the gate to the link half rather than to the section.
    await withPortal({ mode: 'transition' }, async ({ backend, api }) => {
      const friend = await api.friendWithLogin(tag('modeonly'))
      await trackGoogle(page, { fulfilWith: GIS_STUB })

      await page.goto(`${backend.baseUrl}/`)
      await page.getByRole('button', { name: 'Osobné prihlásenie' }).click()
      await page.getByPlaceholder('Zadajte užívateľské meno').fill(friend.username)
      await page.getByPlaceholder('Zadajte heslo').fill(friend.password)
      await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
      await expect(page.getByRole('heading', { name: PORTAL_HEADING })).toBeVisible()

      await openProfileSection(page)
      await expect(sectionOf(page), 'not modern ⇒ no link offer the server would refuse')
        .toHaveCount(0)
      // Non-vacuity: the rest of the modal really did render.
      await expect(page.getByRole('dialog').locator('#pp-profile-name')).toBeVisible()
      await page.getByRole('dialog').getByRole('button', { name: 'Zrušiť' }).click()

      // ── flip the SAME backend to modern: the absence above cannot be vacuous ──
      await page.getByRole('button', { name: 'Odhlásiť sa' }).click()
      await api.setAuthMode('modern')
      await loginModern(page, backend, friend)
      await promptOf(page).getByRole('button', { name: PROMPT_LATER, exact: true }).click()
      await openProfileSection(page)
      await expect(sectionOf(page), 'modern ⇒ the very same friend gets the section')
        .toBeVisible()
    })
  })

  test('an UNCONFIGURED deployment shows no trace of the section and contacts Google zero times', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withPortal({ env: { GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_TEST_MODE: '' } }, async ({ backend, ctx, api }) => {
      expect((await (await ctx.get('/api/friends/auth-mode')).json()).googleClientId).toBeNull()
      const friend = await api.friendWithLogin(tag('noconf7'))
      const hits = await trackGoogle(page)

      await loginModern(page, backend, friend)
      const dialog = await openProfileSection(page).then(() => page.getByRole('dialog'))
      await expect(sectionOf(page)).toHaveCount(0)
      await expect(dialog, 'no trace at all').not.toContainText('Google')
      await page.waitForLoadState('networkidle')
      expect(hits, 'an unconfigured deployment must be Google-free').toEqual([])
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §UC-GA-008 — the invite-registration Google attach (GA-T8)
//
// ⚠ NO NEW ENDPOINT. The credential rides the EXISTING public
// `POST /api/invitations/register` (07 §UC-IA-003) as an optional
// `google_id_token`, on that endpoint's own `abuseLimiter` bucket. So the first
// obligation of this section is a NEGATIVE one: the no-token path must be
// byte-identical to what module 07 shipped — asserted here on the RAW response
// text and on the STORED ROW, because "the existing invite specs still pass" is
// necessary and nowhere near sufficient (they never look at the two new columns).
//
// ⚠ NO AUTH-MODE GATE, and that is a decision, not an omission. §UC-GA-005's button
// and §UC-GA-006's prompt additionally require modern mode because the endpoint they
// post to (§UC-GA-004's `PUT /:id/google-link`) answers 409 in legacy — the reason
// §UC-GA-007 states verbatim. `POST /invitations/register` has no such guard and must
// not grow one: it writes only a NEW `invitations` row, approval (module 07) mints a
// username + temp password regardless of auth mode, and the attach is a frozen record
// for §UC-GA-009 to consume. GA-T5's legacy hazard — planting an alternative
// credential on an EXISTING friend row, reachable because the shared office password
// hands anyone a session for anyone — has no analogue here. These tests therefore run
// on the harness's DEFAULT (legacy) backend on purpose, and one of them flips the same
// backend to modern to show the answer does not move.
// ═════════════════════════════════════════════════════════════════════════════

const ATTACH_INVALID = 'Overenie Google účtu zlyhalo, skúste to znova'
const ATTACH_ON_FRIEND = 'Tento Google účet je už prepojený s existujúcim účtom. Prihláste sa cez Google.'
const ATTACH_ON_INVITATION = 'Registrácia s týmto Google účtom už existuje'

test.describe('§UC-GA-008 — POST /api/invitations/register, the optional google_id_token', () => {
  test('NO token ⇒ byte-identical to module 07: the same 201 body, the same row, both Google columns NULL', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const { friend, code } = await api.inviteCode(tag('plain'))
      const phone = uniquePhone()

      const res = await api.register({
        invite_code: code, name: 'Bez Googlu', phone, email: 'plain@example.test', username: `plainu${phoneSeq}`,
      })
      expect(res.status()).toBe(201)
      // ⚠ RAW TEXT, not a key check: the endpoint's whole reply is this literal, and
      // a body that grew a field would still satisfy `{ success: true }`.
      expect(await res.text(), 'the 201 body must not move at all').toBe('{"success":true}')

      const row = api.invitationRow(phone)
      expect(row.name).toBe('Bez Googlu')
      expect(row.email).toBe('plain@example.test')
      expect(row.username).toBe(`plainu${phoneSeq}`)
      expect(row.status).toBe('pending')
      expect(row.invited_by_friend_id).toBe(friend.id)
      expect(row.source, 'the GSO-T10 column is untouched by this row').toBeNull()
      expect(row.google_sub, 'no token ⇒ nothing attached').toBeNull()
      expect(row.google_email).toBeNull()

      // And an explicitly EMPTY token is the same "absent" (§UC-GA-008: absent/empty).
      const phone2 = uniquePhone()
      const empty = await api.register({ invite_code: code, name: 'Prázdny', phone: phone2, google_id_token: '' })
      expect(empty.status()).toBe(201)
      expect(await empty.text()).toBe('{"success":true}')
      expect(api.invitationRow(phone2).google_sub).toBeNull()
    })
  })

  test('a valid TEST token attaches: the row carries google_sub + google_email, the RESPONSE names neither', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const { code } = await api.inviteCode(tag('attach'))
      const phone = uniquePhone()
      const sub = `ga8-attach-${uniq}`

      const res = await api.register({
        invite_code: code, name: 'S Googlom', phone, email: 'form@example.test',
        google_id_token: `TEST:${sub}:google@example.test`,
      })
      expect(res.status()).toBe(201)
      // The strip rule (§UC-GA-013): the identity key is never published, on any
      // surface, and the reply of a PUBLIC endpoint least of all.
      const text = await res.text()
      expect(text).toBe('{"success":true}')
      expect(text).not.toMatch(STRIP_RE)
      expect(text).not.toContain(sub)

      const row = api.invitationRow(phone)
      expect(row.google_sub).toBe(sub)
      // ⚠ THE TOKEN'S address, not the form's — they differ here on purpose.
      expect(row.google_email).toBe('google@example.test')
      expect(row.email, 'the form e-mail is a separate field and is untouched').toBe('form@example.test')
    })
  })

  test('the type/length guard answers 400 with field:google_id_token — never a 500, and nothing is written', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const { code } = await api.inviteCode(tag('guard'))
      const before = api.invitationCount()

      for (const [label, value] of [
        ['a number', 123],
        ['an object', {}],
        ['an array', ['TEST:a:b@c.d']],
        ['a boolean', true],
        ['4097 chars', 'a'.repeat(4097)],
      ]) {
        const res = await api.register({
          invite_code: code, name: `Guard ${label}`, phone: uniquePhone(), google_id_token: value,
        })
        expect(res.status(), `${label} ⇒ 400`).toBe(400)
        const body = await res.json()
        expect(body.error, label).toBe(BAD_TOKEN)
        expect(body.field, 'the field marker is overridden for this endpoint').toBe('google_id_token')
      }

      // The BOUNDARY: 4096 chars passes the length guard and is then simply an
      // unverifiable token — a different answer, which is what proves the 4097 above
      // was the LENGTH guard and not a generic rejection.
      const atLimit = await api.register({
        invite_code: code, name: 'Guard limit', phone: uniquePhone(), google_id_token: 'a'.repeat(4096),
      })
      expect(atLimit.status()).toBe(400)
      expect((await atLimit.json()).field).toBe('google')

      expect(api.invitationCount(), 'a rejected attach writes no invitation at all').toBe(before)
    })
  })

  test('an unverifiable token is a 400 field:google — registration is not a login, so never a 401', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const { code } = await api.inviteCode(tag('bad'))
      const before = api.invitationCount()

      for (const bad of ['garbage', 'TEST:', 'TEST::x@y.z', 'aaa.bbb.ccc']) {
        const res = await api.register({
          invite_code: code, name: 'Zlý token', phone: uniquePhone(), google_id_token: bad,
        })
        expect(res.status(), `${bad} ⇒ 400, NOT 401`).toBe(400)
        const body = await res.json()
        expect(body.error).toBe(ATTACH_INVALID)
        expect(body.field, 'a bad token here is a bad FIELD — the form stays filled').toBe('google')
      }
      expect(api.invitationCount()).toBe(before)
    })
  })

  test('a sub already on a FRIEND row ⇒ 409 whose body names no friend, and no invitation is written', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const { code } = await api.inviteCode(tag('dupf'))
      const holder = await api.plainFriend(tag('holder'))
      const sub = `ga8-onfriend-${uniq}`
      api.linkGoogle(holder.id, { sub, email: 'holder@example.test' })
      const before = api.invitationCount()

      const res = await api.register({
        invite_code: code, name: 'Duplicitný', phone: uniquePhone(),
        google_id_token: `TEST:${sub}:holder@example.test`,
      })
      expect(res.status()).toBe(409)
      const text = await res.text()
      expect(JSON.parse(text).error).toBe(ATTACH_ON_FRIEND)
      expect(JSON.parse(text).field).toBe('google')
      // ⚠ The §UC-GA-004 rule, inherited: a courtesy 409 must not turn a public form
      // into an "is this Google account one of yours?" directory.
      expect(text, 'the 409 must not name the friend').not.toContain(holder.name)
      expect(text).not.toContain(`"${holder.id}"`)
      expect(text).not.toMatch(STRIP_RE)
      expect(api.invitationCount()).toBe(before)
    })
  })

  test('the friend-side collision is NOT scoped to active friends', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const { code } = await api.inviteCode(tag('dupinact'))
      const holder = await api.plainFriend(tag('inactive'))
      const sub = `ga8-inactive-${uniq}`
      api.linkGoogle(holder.id, { sub })
      await api.deactivate(holder.id)

      const res = await api.register({
        invite_code: code, name: 'Neaktívny držiteľ', phone: uniquePhone(),
        google_id_token: `TEST:${sub}:x@example.test`,
      })
      // The authoritative backstop is `idx_friends_google_sub`, which does not care
      // about `active` — a courtesy check that did would send the applicant into an
      // approval that cannot succeed.
      expect(res.status()).toBe(409)
      expect((await res.json()).error).toBe(ATTACH_ON_FRIEND)
    })
  })

  test('a sub already on another PENDING invitation ⇒ its own, DIFFERENT 409 — and a closed one does not block', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const { code } = await api.inviteCode(tag('dupinv'))
      const sub = `ga8-oninv-${uniq}`
      const firstPhone = uniquePhone()

      expect((await api.register({
        invite_code: code, name: 'Prvý', phone: firstPhone, google_id_token: `TEST:${sub}:a@example.test`,
      })).status()).toBe(201)

      const dup = await api.register({
        invite_code: code, name: 'Druhý', phone: uniquePhone(), google_id_token: `TEST:${sub}:a@example.test`,
      })
      expect(dup.status()).toBe(409)
      const body = await dup.json()
      // ⚠ The two 409s are DIFFERENT sentences — "you already have an account" and
      // "your registration is already queued" are different facts about the applicant.
      expect(body.error).toBe(ATTACH_ON_INVITATION)
      expect(body.error).not.toBe(ATTACH_ON_FRIEND)
      expect(body.field).toBe('google')

      // ⚠ PENDING-only (the phone-dedupe precedent): once the first registration is
      // closed out, the same Google account may register again. There is no partial
      // index on `invitations` by design, so this is an app check and it must be
      // exactly this narrow.
      api.setInvitationStatus(api.invitationRow(firstPhone).id, 'rejected')
      const again = await api.register({
        invite_code: code, name: 'Znova', phone: uniquePhone(), google_id_token: `TEST:${sub}:a@example.test`,
      })
      expect(again.status(), 'a rejected/processed invitation must not block forever').toBe(201)
    })
  })

  test('a token attaches in LEGACY mode exactly as in modern — no auth-mode gate on this path', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api, ctx }) => {
      const { code } = await api.inviteCode(tag('mode'))
      expect((await (await ctx.get('/api/friends/auth-mode')).json()).authMode,
        'the harness backend is seeded legacy — that is the point of this test').toBe('legacy')

      const legacyPhone = uniquePhone()
      expect((await api.register({
        invite_code: code, name: 'Legacy', phone: legacyPhone, google_id_token: `TEST:ga8-legacy-${uniq}:l@example.test`,
      })).status(), 'legacy must NOT refuse the attach').toBe(201)
      expect(api.invitationRow(legacyPhone).google_sub).toBe(`ga8-legacy-${uniq}`)

      // The same body on the SAME backend once flipped: the answer does not move.
      await api.setModernMode()
      const modernPhone = uniquePhone()
      expect((await api.register({
        invite_code: code, name: 'Modern', phone: modernPhone, google_id_token: `TEST:ga8-modern-${uniq}:m@example.test`,
      })).status()).toBe(201)
      expect(api.invitationRow(modernPhone).google_sub).toBe(`ga8-modern-${uniq}`)
    })
  })

  test('an UNCONFIGURED deployment: the plain registration is untouched, a token gets the 503', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({ GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_TEST_MODE: '' }, async ({ api, ctx }) => {
      expect((await (await ctx.get('/api/friends/auth-mode')).json()).googleClientId).toBeNull()
      const { code } = await api.inviteCode(tag('noconf'))

      // ⚠ THE HALF THAT MATTERS MOST: with Google off, the public registration form
      // this endpoint has always served must be completely unaffected.
      const phone = uniquePhone()
      const plain = await api.register({ invite_code: code, name: 'Bez Googlu', phone })
      expect(plain.status()).toBe(201)
      expect(await plain.text()).toBe('{"success":true}')

      // A token arriving anyway (the block does not render, so this is anomalous) is
      // REFUSED, not silently dropped — an invitation the applicant believes carries
      // their Google account but does not is worse than an error.
      const withToken = await api.register({
        invite_code: code, name: 'S Googlom', phone: uniquePhone(),
        google_id_token: `TEST:ga8-noconf-${uniq}:x@example.test`,
      })
      expect(withToken.status()).toBe(503)
      expect((await withToken.json()).error).toBe(NOT_CONFIGURED)
    })
  })

  test('a duplicate PENDING phone still answers module 07\'s 409, byte-identical, with a token attached', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({}, async ({ api }) => {
      const { code } = await api.inviteCode(tag('phone'))
      const phone = uniquePhone()
      expect((await api.register({ invite_code: code, name: 'Prvý', phone })).status()).toBe(201)

      // ⚠ The phone rule OUTRANKS the Google attach and keeps its exact shape: the
      // same sentence, and NO `field` (module 07 never set one). The attach must not
      // relabel somebody else's 409, and a valid token must not buy a second row.
      const dup = await api.register({
        invite_code: code, name: 'Druhý', phone,
        google_id_token: `TEST:ga8-phone-${uniq}:p@example.test`,
      })
      expect(dup.status()).toBe(409)
      const body = await dup.json()
      expect(body.error).toBe('Registrácia s týmto číslom už existuje')
      expect(body.field, 'module 07 set no field marker on this one').toBeUndefined()
      expect(api.invitationRow(phone).google_sub, 'and nothing was attached to the FIRST row').toBeNull()
    })
  })

  test('⚠ the race the `await` opened: a lost phone race is a 409 at the CONSTRAINT too, never a 500', () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)

    // ⚠ WHY THIS IS A PROBE AND NOT AN HTTP TEST, stated because the gap is the
    // whole point. Making this handler `async` is the first place in the repo where
    // the standing `instances: 1` "handlers are fully synchronous" assumption stops
    // holding: request A can now yield inside `verifyGoogleIdToken` and request B can
    // insert the same pending phone in that window. But the window is UNREACHABLE
    // from this suite — the only tokens that verify are the `TEST:` seam's, which
    // resolve in a microtask, and a microtask yield returns to the same task before
    // any other HTTP callback runs. A token that costs a real macrotask (a JWKS
    // fetch) never verifies, so it never reaches the INSERT. Layer 1 (the re-read
    // before the INSERT) therefore cannot be observed over HTTP either.
    //
    // What CAN be pinned, and what actually rots, is the ERROR SHAPE layer 2's guard
    // reads: `isPendingPhoneConflict` matches on `code` + the exact SQLite message,
    // and a future index on this table (or a driver upgrade) could change either and
    // turn the guard into silent dead code — restoring the 500 it exists to prevent.
    // The friends.js `isGoogleSubConflict` precedent, minus the route export.
    const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const SCHEMA_URL = 'file://' + join(REPO_ROOT, 'backend', 'src', 'db', 'schema.js')
    test.skip(!existsSync(join(REPO_ROOT, 'backend', 'src', 'db', 'schema.js')), NEEDS_SOURCE)

    const dir = mkdtempSync(join(tmpdir(), 'ga-t8-probe-'))
    const script = join(dir, 'probe.mjs')
    try {
      writeFileSync(script, `import db from '${SCHEMA_URL}';
const out = {};
// Non-vacuity: the partial unique index must really exist, or everything below is
// asserting the behaviour of a table with no constraint on it.
out.indexSql = (db.get("SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_invitations_phone_pending'") || {}).sql || null;
// \`invited_by_friend_id\` is NOT NULL with an FK, so the inviter is real — the
// GA-T5 probe's shape (a cycle, then a friend on it).
db.run("INSERT INTO order_cycles (name) VALUES ('GA-T8 probe cycle')");
const cyc = db.get('SELECT id FROM order_cycles ORDER BY id DESC LIMIT 1').id;
db.run("INSERT INTO friends (name, cycle_id, access_token) VALUES ('Inviter', ?, 'ga8-probe')", [cyc]);
const inviter = db.get("SELECT id FROM friends WHERE access_token = 'ga8-probe'").id;
db.run("INSERT INTO invitations (invite_code, invited_by_friend_id, name, phone, status) VALUES ('X', ?, 'A', '+421999000111', 'pending')", [inviter]);
try {
  db.run("INSERT INTO invitations (invite_code, invited_by_friend_id, name, phone, status) VALUES ('X', ?, 'B', '+421999000111', 'pending')", [inviter]);
  out.threw = false;
} catch (e) {
  out.threw = true;
  out.code = e.code;
  out.message = e.message;
  // The route's guard, character for character (invitations.js isPendingPhoneConflict).
  out.guardMatches = typeof e?.code === 'string'
    && e.code.startsWith('SQLITE_CONSTRAINT')
    && /UNIQUE constraint failed: invitations\\.phone/.test(String(e?.message || ''));
}
// A CLOSED registration on the same number must still be insertable — the index is
// partial, and layer 2 must not start answering 409 for a state that is legal.
try {
  db.run("INSERT INTO invitations (invite_code, invited_by_friend_id, name, phone, status) VALUES ('X', ?, 'C', '+421999000111', 'rejected')", [inviter]);
  out.closedInsertOk = true;
} catch { out.closedInsertOk = false; }
console.log('@@PROBE@@' + JSON.stringify(out));
`)
      const stdout = execFileSync(process.execPath, [script], {
        env: { ...process.env, DB_PATH: join(dir, 'probe.sqlite'), GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_TEST_MODE: '' },
        encoding: 'utf8',
        cwd: REPO_ROOT,
      })
      const m = stdout.match(/@@PROBE@@(.*)/)
      expect(m, `probe produced no marker. stdout:\n${stdout}`).toBeTruthy()
      const out = JSON.parse(m[1])

      expect(out.indexSql, 'idx_invitations_phone_pending must exist').toContain("status = 'pending'")
      expect(out.threw, 'a second PENDING row on one phone must be refused by the DB').toBe(true)
      expect(out.guardMatches,
        `the route's isPendingPhoneConflict no longer matches what sqlite throws — layer 2 is dead code and a lost race is a 500 again.\ncode=${out.code}\nmessage=${out.message}`)
        .toBe(true)
      expect(out.closedInsertOk, 'the index is PARTIAL — a rejected/processed row must not collide').toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('§UC-GA-013 — the attach rides the endpoint\'s EXISTING abuseLimiter, not authLimiter', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withGoogleBackend({ RATE_LIMIT_ABUSE_MAX: '12' }, async ({ api, ctx }) => {
      const { code } = await api.inviteCode(tag('bucket'))

      let limited = false
      for (let i = 0; i < 30 && !limited; i++) {
        const res = await api.register({
          invite_code: code, name: 'Bucket', phone: uniquePhone(),
          google_id_token: `TEST:ga8-bucket-${uniq}-${i}:b@example.test`,
        })
        if (res.status() === 429) limited = true
      }
      expect(limited, 'the register attach must be rate limited at all').toBe(true)

      // ⚠ THE CLAIM: the SAME bucket the endpoint already sat in. The invite-code
      // lookup is the other abuseLimiter route, so it must be exhausted too…
      expect((await ctx.get(`/api/invitations/code/${code}`)).status(),
        'one endpoint, one bucket — no new limiter for the attach').toBe(429)
      // …and the STRICT credential bucket must be untouched: moving this endpoint to
      // authLimiter would let a registration spammer lock the office out of login.
      expect((await ctx.post('/api/friends/auth', { data: { username: 'nobody', password: 'nope' } })).status(),
        'authLimiter must be a separate bucket still').not.toBe(429)
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §UC-GA-008 — the GIS block on `/invite/:code` (GA-T8, UI half)
//
// It lives in THIS file, not in `invite-register-shell.spec.js`, because every
// mechanism it needs is already here and must stay in one home: `GIS_STUB`,
// `trackGoogle` (the RD-DS-6 rule — assert the REQUEST, not just the DOM) and
// `stubAuthMode`. §UC-GA-013's obligation-5 UI bullet names "invite register" in
// this file's list. `invite-register-shell.spec.js` keeps the SHELL (chrome,
// composition, 320px, the four fields) and passes unchanged.
//
// ⚠ ON THE GATE, WHICH IS LEGACY MODE — deliberately. That is the strongest form
// of the no-mode-gate decision above: the block has to render on a real target
// that is not modern, with no stub at all.
// ═════════════════════════════════════════════════════════════════════════════

const INVITE_GOOGLE_LABEL = 'Prihlásenie cez Google'
const INVITE_GOOGLE_HELP = 'Nepovinné. Po schválení sa budete môcť prihlásiť svojím Google účtom.'
const INVITE_GOOGLE_DETACH = 'Zrušiť'

test.describe('§UC-GA-008 — the invite-registration Google block', () => {
  let inviteCtx = null
  let inviteCode = ''
  let inviteAdminToken = ''

  test.beforeAll(async ({ baseURL }) => {
    inviteCtx = await playwrightRequest.newContext({ baseURL })
    const login = await inviteCtx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status(), 'admin login').toBe(200)
    inviteAdminToken = (await login.json()).token
    const adminHeaders = { 'X-Admin-Token': inviteAdminToken }

    const name = `GA8 Inviter ${uniq}`
    const username = `ga8i${uniq}`.replace(/[^a-z0-9_]/g, '').slice(0, 30)
    const created = await inviteCtx.post('/api/friends', { headers: adminHeaders, data: { name } })
    expect(created.status(), 'friend create').toBe(201)
    const friend = await created.json()
    expect((await inviteCtx.put(`/api/friends/${friend.id}/admin-username`, {
      headers: adminHeaders, data: { username },
    })).status()).toBe(200)
    expect((await inviteCtx.put(`/api/friends/${friend.id}/reset-password`, {
      headers: adminHeaders, data: { password: 'initPass1' },
    })).status()).toBe(200)
    const auth = await inviteCtx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
    expect(auth.status(), 'friend login').toBe(200)
    const first = (await auth.json()).token
    const chg = await inviteCtx.put(`/api/friends/${friend.id}/change-password`, {
      headers: { Authorization: `Bearer ${first}` },
      data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
    })
    expect(chg.status(), 'forced change').toBe(200)
    const token = (await chg.json()).token || first

    const code = await inviteCtx.get('/api/invitations/my-code', { headers: { Authorization: `Bearer ${token}` } })
    expect(code.status(), 'my-code').toBe(200)
    inviteCode = (await code.json()).inviteCode
    expect(inviteCode).toBeTruthy()
  })

  test.afterAll(async () => { await inviteCtx?.dispose() })

  /** The pending invitation as the ADMIN sees it — `GET /api/invitations` is `SELECT i.*`. */
  async function pendingByPhone(phone) {
    const list = await inviteCtx.get('/api/invitations?status=pending', {
      headers: { 'X-Admin-Token': inviteAdminToken },
    })
    expect(list.status()).toBe(200)
    return (await list.json()).find((r) => r.phone === phone) || null
  }

  async function fillForm(page, { name, phone, email }) {
    await page.getByLabel('Meno a priezvisko').fill(name)
    await page.getByLabel('Telefón').fill(phone)
    await page.getByLabel('Email').fill(email)
  }

  test('configured ⇒ the block renders with its exact copy and really loads GIS — on a LEGACY target', async ({ page }) => {
    const hits = await trackGoogle(page, { fulfilWith: GIS_STUB })
    await page.goto(`/invite/${inviteCode}`)
    await expect(page.getByTestId('invite-form')).toBeVisible()

    const mode = await (await page.request.get('/api/friends/auth-mode')).json()
    test.skip(mode.googleClientId === null, 'this target has no GOOGLE_CLIENT_ID')

    const block = page.getByTestId('invite-google')
    await expect(block).toBeVisible()
    await expect(block.locator('.field-lbl')).toHaveText(INVITE_GOOGLE_LABEL)
    await expect(block.locator('.field-help')).toHaveText(INVITE_GOOGLE_HELP)

    // ⚠ The RD-DS-6 lesson: assert the REQUEST, not just the DOM.
    expect(hits.filter((u) => u.includes('/gsi/client')).length,
      'the loader must actually fetch the GIS client').toBeGreaterThan(0)
    await expect(page.getByTestId('gis-stub-button')).toBeVisible()

    const calls = await page.evaluate(() => window.__gisCalls)
    expect(calls.initialize.length, 'one global callback, registered once').toBe(1)
    expect(calls.initialize[0].client_id, 'the SERVED client id, not a build-time constant').toBe(mode.googleClientId)
    expect(calls.initialize[0].hasCallback).toBe(true)
    expect(calls.renderButton.length).toBe(1)
    expect(calls.renderButton[0].testid, 'rendered into our own container').toBe('invite-google-signin')
    expect(calls.renderButton[0].opts.locale).toBe('sk')

    // The block sits BELOW the four existing fields and ABOVE the submit.
    const emailBox = await page.getByLabel('Email').boundingBox()
    const blockBox = await block.boundingBox()
    const submitBox = await page.getByRole('button', { name: 'Odoslať registráciu' }).boundingBox()
    expect(blockBox.y).toBeGreaterThan(emailBox.y)
    expect(submitBox.y).toBeGreaterThan(blockBox.y)
  })

  test('googleClientId EXPLICITLY null ⇒ no block at all, and zero requests to Google', async ({ page }) => {
    // ⚠ NON-VACUOUS BY CONSTRUCTION: the stub CARRIES the key with a `null` value,
    // so this asserts the flag is the gate (the GA-T4 note on this file's stubs).
    const hits = await trackGoogle(page)
    await stubAuthMode(page, { authMode: 'legacy', googleClientId: null })
    await page.goto(`/invite/${inviteCode}`)
    await expect(page.getByTestId('invite-form')).toBeVisible()

    await expect(page.getByTestId('invite-google')).toHaveCount(0)
    await expect(page.getByTestId('invite-google-signin')).toHaveCount(0)
    // Non-vacuity: the form itself really did render.
    await expect(page.getByLabel('Meno a priezvisko')).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(hits, 'an unconfigured deployment must be Google-free').toEqual([])
  })

  test('an INVALID code renders the dead card and contacts Google zero times', async ({ page }) => {
    // The control lives inside the FORM state. A loader fired on mount would make
    // `/invite/:code` contact Google for anyone who mistypes a link.
    const hits = await trackGoogle(page)
    await page.goto(`/invite/NOPE-GA8-${uniq}`)
    await expect(page.getByTestId('invite-invalid')).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(hits, 'no form, no Google').toEqual([])
  })

  test('the credential is captured, shown as an e-mail with a "Zrušiť" control, and rides the submit', async ({ page }) => {
    await trackGoogle(page, { fulfilWith: GIS_STUB })
    await page.goto(`/invite/${inviteCode}`)
    await expect(page.getByTestId('gis-stub-button')).toBeVisible()

    const phone = uniquePhone()
    await fillForm(page, { name: 'Attach UI', phone, email: 'form-ui@example.test' })

    const sub = `ga8-ui-${uniq}`
    // The E2E BOUNDARY (§UC-GA-013): Google's iframe cannot run here, so the
    // credential is delivered exactly as GIS would — through the callback the view
    // registered, which the stub captured.
    await page.evaluate((s) => window.__gisCallback({ credential: `TEST:${s}:picked@example.test` }), sub)

    const block = page.getByTestId('invite-google')
    // ⚠ The `TEST:` seam token is NOT a JWS, so the view — which decodes the label
    // out of the token's own payload and has no business knowing about the seam —
    // legitimately falls back to the neutral wording. The e-mail half is pinned by
    // its own test below, with a JWS-shaped token.
    await expect(block.getByTestId('invite-google-account')).toHaveText('Google účet je pripojený')
    await expect(block.getByTestId('invite-google-signin'), 'the button gives way to the captured state').toHaveCount(0)

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/invitations/register') && r.method() === 'POST'),
      page.getByRole('button', { name: 'Odoslať registráciu' }).click(),
    ])
    // ⚠ The token is held in MEMORY and sent ONLY with the submit.
    expect(JSON.parse(req.postData()).google_id_token).toBe(`TEST:${sub}:picked@example.test`)

    await expect(page.getByTestId('invite-success')).toBeVisible()
    const row = await pendingByPhone(phone)
    expect(row, 'the invitation was created').toBeTruthy()
    expect(row.google_sub).toBe(sub)
    expect(row.google_email).toBe('picked@example.test')
  })

  test('"Zrušiť" detaches before the submit: the button comes back and the body carries NO token', async ({ page }) => {
    await trackGoogle(page, { fulfilWith: GIS_STUB })
    await page.goto(`/invite/${inviteCode}`)
    await expect(page.getByTestId('gis-stub-button')).toBeVisible()

    const phone = uniquePhone()
    await fillForm(page, { name: 'Detach UI', phone, email: 'detach@example.test' })
    await page.evaluate((s) => window.__gisCallback({ credential: `TEST:${s}:drop@example.test` }), `ga8-detach-${uniq}`)
    await expect(page.getByTestId('invite-google-attached')).toBeVisible()

    await page.getByTestId('invite-google').getByRole('button', { name: INVITE_GOOGLE_DETACH, exact: true }).click()
    await expect(page.getByTestId('invite-google-attached')).toHaveCount(0)
    // ⚠ AND THE BUTTON COMES BACK, RENDERED — a detach that left an empty mount
    // point would be a dead end with no way to attach again.
    await expect(page.getByTestId('gis-stub-button')).toBeVisible()

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/invitations/register') && r.method() === 'POST'),
      page.getByRole('button', { name: 'Odoslať registráciu' }).click(),
    ])
    expect(Object.keys(JSON.parse(req.postData())), 'a detached form sends no google_id_token')
      .not.toContain('google_id_token')

    await expect(page.getByTestId('invite-success')).toBeVisible()
    expect((await pendingByPhone(phone)).google_sub).toBeNull()
  })

  test('a field:google 409 keeps the FORM FILLED — the whole reason it is a field error', async ({ page }) => {
    await trackGoogle(page, { fulfilWith: GIS_STUB })

    // The collision is manufactured through the app itself: one pending invitation
    // already holding this sub. No DB write, so this cannot self-skip.
    const sub = `ga8-taken-${uniq}`
    const firstPhone = uniquePhone()
    expect((await inviteCtx.post('/api/invitations/register', {
      data: { invite_code: inviteCode, name: 'Prvý GA8', phone: firstPhone, google_id_token: `TEST:${sub}:taken@example.test` },
    })).status()).toBe(201)

    await page.goto(`/invite/${inviteCode}`)
    await expect(page.getByTestId('gis-stub-button')).toBeVisible()
    const phone = uniquePhone()
    await fillForm(page, { name: 'Konflikt UI', phone, email: 'conflict@example.test' })
    await page.evaluate((s) => window.__gisCallback({ credential: `TEST:${s}:taken@example.test` }), sub)
    await expect(page.getByTestId('invite-google-attached')).toBeVisible()

    await page.getByRole('button', { name: 'Odoslať registráciu' }).click()

    // The view's EXISTING error display, with the server's sentence verbatim.
    await expect(page.locator('.banner.danger')).toHaveText(ATTACH_ON_INVITATION)
    // ⚠ THE POINT: the applicant does not retype anything.
    await expect(page.getByTestId('invite-form'), 'still on the form, not the success state').toBeVisible()
    await expect(page.getByLabel('Meno a priezvisko')).toHaveValue('Konflikt UI')
    await expect(page.getByLabel('Telefón')).toHaveValue(phone)
    await expect(page.getByLabel('Email')).toHaveValue('conflict@example.test')
    await expect(page.getByTestId('invite-google-attached'), 'and the attachment survives too').toBeVisible()
    expect(await pendingByPhone(phone), 'nothing was written').toBeNull()
  })

  test('the captured account is shown as its E-MAIL, and an unverifiable token 400s with the form intact', async ({ page }) => {
    await trackGoogle(page, { fulfilWith: GIS_STUB })
    await page.goto(`/invite/${inviteCode}`)
    await expect(page.getByTestId('gis-stub-button')).toBeVisible()

    const phone = uniquePhone()
    await fillForm(page, { name: 'Email UI', phone, email: 'form@example.test' })

    // ⚠ A JWS-SHAPED token whose payload really carries an `email` claim — which is
    // what a real GIS credential is. The view decodes it FOR DISPLAY ONLY; the
    // server re-verifies the whole thing, and this one cannot verify, which is
    // exactly what the second half of this test is about.
    const claims = Buffer.from(JSON.stringify({ email: 'picked@example.test', sub: 'x' })).toString('base64url')
    const jws = `eyJhbGciOiJSUzI1NiJ9.${claims}.c2ln`
    await page.evaluate((t) => window.__gisCallback({ credential: t }), jws)
    await expect(page.getByTestId('invite-google-account')).toHaveText('picked@example.test')

    await page.getByRole('button', { name: 'Odoslať registráciu' }).click()

    // 400, not 401 — the server's own sentence, in the view's existing error display.
    await expect(page.locator('.banner.danger')).toHaveText(ATTACH_INVALID)
    await expect(page.getByTestId('invite-form')).toBeVisible()
    await expect(page.getByLabel('Meno a priezvisko')).toHaveValue('Email UI')
    await expect(page.getByLabel('Telefón')).toHaveValue(phone)
    expect(await pendingByPhone(phone), 'nothing was written').toBeNull()
  })
})
