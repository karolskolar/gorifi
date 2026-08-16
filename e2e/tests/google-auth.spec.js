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
import { ADMIN_PASSWORD } from '../fixtures.js'
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
