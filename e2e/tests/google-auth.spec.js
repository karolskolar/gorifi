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
  }
  return { api }
}

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
    initialize: (cfg) => { window.__gisCalls.initialize.push({ client_id: cfg.client_id, hasCallback: typeof cfg.callback === 'function' }) },
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
