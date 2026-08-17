import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'

// FUP-T11 — the last FIVE live instances of the bcrypt non-string 500.
//
// ⚠ THE PATTERN IS EIGHT-FOR-EIGHT, NOT A COINCIDENCE. `bcryptjs` THROWS
// `Illegal arguments: <type>, string` on any non-string input, so every
// `compare`/`hash` call reached without a `typeof … === 'string'` guard turns a
// merely-malformed body into a 500 `Nieco sa pokazilo` PLUS a full stack in the
// server log. ML-T6 fixed two (`friends.js` change-password), FUP-T10 a third
// (`onboarding.js`); this row closes the remaining five:
//
//   admin.js `verifyAdminPassword`  → POST /api/admin/login            PUBLIC, no precondition
//   friends.js:126 `comparePassword`→ POST /api/friends/auth           PUBLIC (needs a username)
//   friends.js:255 `hashPassword`   → POST /api/friends/:id/setup-credentials
//   friends.js:833 `hashPassword`   → PUT  /api/friends/:id/reset-password
//   admin.js:207                    → POST /api/admin/change-password  BOTH inputs
//
// ⚠ WHY THE ADMIN ONE IS THE WORST: `POST /api/admin/login` needs no credentials,
// no fixture and no precondition at all. `curl -d '{"password":{"length":12}}'`
// answers 500 and writes ~1 KB of stack, unauthenticated, on the most exposed
// endpoint in the app — a free remote log-flood, which is exactly what the
// FUP-T3/FUP-T7 rule ("no stack log on a client-triggerable branch") exists to
// prevent. The wrong STATUS is the bug; the stack is the abuse surface.
//
// ⚠ THE DESIGN SPLIT UNDER TEST (see the comments in the two source files):
//   • COMPARE-style helpers guard INSIDE the helper and `return false`, which
//     routes a malformed body into each caller's EXISTING 401 with no new branch
//     and — critically for the two public routes — no new oracle: a malformed
//     password is now indistinguishable from a wrong one.
//   • HASH-style inputs cannot do that (there is no meaningful `false`), so they
//     are guarded AT THE ROUTE, returning that route's existing 400 and message.
// Both halves are asserted here, per route, message by message.
//
// ⚠ NOTHING MAY LOOSEN. Every block below carries counter-assertions: a wrong
// password must still be refused with the identical status and message, a short
// string must still fail the length rule, and a correct password must still
// succeed all the way through to a working login. Without those, a guard written
// as `return true` — or one that forgot the length rule — would pass every 4xx
// assertion above it.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'

// ── The route messages, REUSED VERBATIM from the handlers. A new string here
// would be a silent copy change on a login screen, so these are copied, never
// re-worded. (Two of them are the app's unaccented legacy Slovak — kept as-is.)
const ADMIN_WRONG_PASSWORD = 'Nespravne heslo'
const ADMIN_WRONG_CURRENT = 'Nespravne aktualne heslo'
const ADMIN_BOTH_REQUIRED = 'Obe hesla su povinne'
const ADMIN_MIN_LENGTH = 10
const ADMIN_NEW_TOO_SHORT = `Nové heslo musí mať aspoň ${ADMIN_MIN_LENGTH} znakov`
const FRIEND_BAD_CREDENTIALS = 'Nesprávne prihlasovacie údaje'
const FRIEND_PASSWORD_TOO_SHORT = 'Heslo musí mať aspoň 8 znakov'

// Every non-string that took the 500 path.
//
// ⚠ The two arrays are NOT the same case, and both are here on purpose (the
// FUP-T10 precedent). A ONE-element array has `length === 1`, so on the routes
// that carry a `password.length < 8` rule it was already refused with a 400 — for
// the wrong reason, but a 400; on `/admin/login` and `/friends/auth`, which have
// no length rule at all, the very same value was a genuine 500. The TWELVE-element
// one clears every length rule in the app natively and was a 500 everywhere.
// ⚠ `true` and the number are the subtle ones: `.length` is `undefined`, and
// `undefined < 8` is `false`, so a bare length comparison WAVES THEM THROUGH.
const MALFORMED = [
  { length: 12 },
  { length: 99 },
  12345678901234,
  ['abcdefghijkl'],
  ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
  true,
]

const label = (v) => JSON.stringify(v)

// Nothing from the exception may reach the client either — a 400 that echoed
// `Illegal arguments: object, string` would be a different leak with a nicer status.
function expectNoInternals(body) {
  const raw = JSON.stringify(body)
  expect(raw, 'no bcrypt internals in the response').not.toMatch(/Illegal arguments|bcrypt/i)
  expect(raw, 'no stack trace in the response').not.toMatch(/at .*\.js|node_modules/)
}

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
let nameSeq = 0
function uniqueUsername(label) {
  const suffix = `${uniq}${++nameSeq}`
  return `${label}${suffix}`.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30)
}

let ctx
let adminToken
// A friend who already HAS credentials — the /friends/auth fixture.
let authFriend
// A friend with NO credentials — the setup-credentials fixture.
let setupFriendId
// A friend the admin resets — the reset-password fixture.
let resetFriendId

const admin = () => ({ 'X-Admin-Token': adminToken })
const shared = () => ({ 'X-Friends-Password': FRIENDS_PASSWORD })

async function adminLogin(password) {
  return ctx.post('/api/admin/login', { data: { password } })
}

// ⚠ There is exactly ONE admin token app-wide (`INSERT OR REPLACE … 'admin_token'`),
// so every successful login INVALIDATES the previous one — including the login this
// helper performs to prove nothing was written. Re-adopting the token here is what
// stops the very next `requireAdmin` request in this file answering
// 'Neautorizovaný prístup' and looking like the fix under test had broken authz.
async function expectAdminPasswordUntouched() {
  const res = await adminLogin(ADMIN_PASSWORD)
  expect(res.status(), 'the shared admin password is untouched').toBe(200)
  adminToken = (await res.json()).token
}

async function createFriend(label) {
  const res = await ctx.post('/api/friends', { headers: admin(), data: { name: `FUP11 ${label} ${uniq}` } })
  expect(res.status(), `friend fixture ${label} created`).toBe(201)
  return (await res.json()).id
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })

  const login = await adminLogin(ADMIN_PASSWORD)
  expect(login.status(), 'admin login for the fixtures').toBe(200)
  adminToken = (await login.json()).token

  setupFriendId = await createFriend('setup')
  resetFriendId = await createFriend('reset')

  // The /friends/auth fixture needs a real username + password pair, and
  // setup-credentials is the only friend-side route that mints one.
  const id = await createFriend('auth')
  const username = uniqueUsername('fup11auth')
  const password = 'fup11AuthPass'
  const setup = await ctx.post(`/api/friends/${id}/setup-credentials`, {
    headers: shared(),
    data: { username, password },
  })
  expect(setup.status(), 'the /friends/auth fixture got credentials').toBe(200)
  authFriend = { id, username, password }
})

test.afterAll(async () => { await ctx?.dispose() })

// ── 1. POST /api/admin/login — public, no precondition ───────────────────────
test.describe('FUP-T11 — POST /api/admin/login', () => {
  for (const password of MALFORMED) {
    test(`a ${label(password)} password is a 401, never a 500`, async () => {
      const res = await adminLogin(password)
      expect(
        res.status(),
        `a malformed body is a client mistake, not a server fault (${label(password)})`,
      ).toBe(401)
      const body = await res.json()
      // ⚠ THE EXISTING MESSAGE — and it is the SAME one a wrong string gets, on
      // purpose. A distinct "malformed" message would be a new oracle on the app's
      // most exposed endpoint.
      expect(body.error, "the route's own message, unchanged").toBe(ADMIN_WRONG_PASSWORD)
      expect(body.field, 'this route never carried a field marker').toBeUndefined()
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: a wrong string password is still refused identically', async () => {
    const res = await adminLogin('definitely-not-the-admin-password')
    expect(res.status(), 'a wrong password still 401s').toBe(401)
    expect((await res.json()).error).toBe(ADMIN_WRONG_PASSWORD)
  })

  test('NOTHING LOOSENED: an absent/empty password still 400s with its own message', async () => {
    for (const password of ['', undefined, null, 0, false]) {
      const res = await adminLogin(password)
      expect(res.status(), `falsy password ${label(password)} still 400s`).toBe(400)
      expect((await res.json()).error).toBe('Heslo je povinne')
    }
  })

  test('NOTHING LOOSENED: the correct password still logs in', async () => {
    // The non-vacuity gate for every 401 above: a guard written as "refuse
    // everything" would have satisfied the whole block.
    const res = await adminLogin(ADMIN_PASSWORD)
    expect(res.status(), 'the real admin password still works').toBe(200)
    const { token } = await res.json()
    expect(token, 'and still mints a token').toBeTruthy()

    // ⚠ ADOPT IT — the same rule `expectAdminPasswordUntouched()` above is written
    // for, and this was the one login in the file that did not follow it. There is
    // exactly ONE admin token app-wide, so this success invalidates the one
    // `beforeAll` minted, and §4 (`PUT /:id/reset-password`, `requireAdmin`) then
    // answers 401 where it asserts 400 — a failure that reads exactly like the fix
    // under test having broken authorization.
    //
    // ⚠ IT ONLY SURVIVED BECAUSE §1b BELOW HAPPENED TO RE-ADOPT — and §1b is
    // `test.skip`ped without `DB_PATH`, so the file passed only when the runner
    // exported it and went red, in an unrelated describe, when it did not. Found on a
    // GA-T10 full-suite run started without `DB_PATH`; fixed HERE so the coupling
    // between an optional env var and an unrelated describe's authz is gone rather
    // than merely satisfied.
    adminToken = token
  })
})

// ── 1b. …and the SAME route on a LEGACY SHA-256 hash ─────────────────────────
//
// ⚠ THE HALF A HELPER-ONLY GUARD WOULD HAVE MISSED, so it gets its own test rather
// than a comment. `verifyAdminPassword` branches on the stored hash: bcrypt goes
// through `comparePassword` (guarded in the helper), but a pre-SEC-S1 SHA-256 hex
// never touches bcrypt at all — it goes to `crypto.createHash().update(password)`,
// which raises its OWN `TypeError: The "data" argument must be of type string…`.
// Same 500, same stack, different exception class, and invisible on any instance
// whose hash has already migrated. This is why the guard sits ABOVE the branch.
//
// Safe to run against the shared fixture: only the STORAGE FORM of the admin
// password changes, never its value — a legacy hex still authenticates by design —
// and the route's own transparent migration re-writes it as bcrypt on the next
// successful login, which is asserted here as the restore.
const DB_PATH = process.env.DB_PATH || ''

test.describe('FUP-T11 — POST /api/admin/login on a LEGACY SHA-256 hash', () => {
  test('a non-string password is a 401 there too, and the hash still migrates', async () => {
    test.skip(!DB_PATH, 'requires DB_PATH to install a legacy SHA-256 admin hash')

    const legacy = createHash('sha256').update(ADMIN_PASSWORD).digest('hex')
    const db = new DatabaseSync(DB_PATH)
    try {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_password'").run(legacy)
    } finally {
      db.close()
    }

    // Non-vacuity: the branch under test is really the legacy one.
    const stored = () => {
      const d = new DatabaseSync(DB_PATH)
      try { return d.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get().value }
      finally { d.close() }
    }
    expect(stored(), 'the legacy hex is really installed').toBe(legacy)

    for (const password of MALFORMED) {
      const res = await adminLogin(password)
      expect(res.status(), `legacy branch refuses ${label(password)} cleanly`).toBe(401)
      expect((await res.json()).error).toBe(ADMIN_WRONG_PASSWORD)
    }

    // NOTHING LOOSENED: a legacy hex still verifies a correct string…
    const ok = await adminLogin(ADMIN_PASSWORD)
    expect(ok.status(), 'a legacy hash still authenticates the real password').toBe(200)
    adminToken = (await ok.json()).token

    // …and that success migrates it to bcrypt, which is also the restore.
    expect(stored(), 'SEC-S1 transparent migration still runs').toMatch(/^\$2[aby]\$/)
  })
})

// ── 2. POST /api/friends/auth — public (needs a username) ────────────────────
test.describe('FUP-T11 — POST /api/friends/auth (personal login)', () => {
  for (const password of MALFORMED) {
    test(`a ${label(password)} password is a 401, never a 500`, async () => {
      const res = await ctx.post('/api/friends/auth', {
        data: { username: authFriend.username, password },
      })
      expect(res.status(), `malformed password ${label(password)} is refused cleanly`).toBe(401)
      const body = await res.json()
      expect(body.error, "the route's own message, unchanged").toBe(FRIEND_BAD_CREDENTIALS)
      expectNoInternals(body)
    })
  }

  test('NO NEW ORACLE: a malformed password reads exactly like an unknown username', async () => {
    // ⚠ The reason the guard lives inside `comparePassword` and returns `false`
    // rather than answering with a distinct 400: this route deliberately gives one
    // message for "no such user", "no password set" and "wrong password". A
    // malformed body must not become a way to ask whether an account exists.
    const known = await ctx.post('/api/friends/auth', {
      data: { username: authFriend.username, password: { length: 12 } },
    })
    const unknown = await ctx.post('/api/friends/auth', {
      data: { username: uniqueUsername('ghost'), password: { length: 12 } },
    })
    expect(known.status(), 'same status').toBe(unknown.status())
    expect((await known.json()).error, 'same message').toBe((await unknown.json()).error)
  })

  test('NOTHING LOOSENED: a wrong string password is still refused identically', async () => {
    const res = await ctx.post('/api/friends/auth', {
      data: { username: authFriend.username, password: 'wrongPass123' },
    })
    expect(res.status()).toBe(401)
    expect((await res.json()).error).toBe(FRIEND_BAD_CREDENTIALS)
  })

  test('NOTHING LOOSENED: the correct credentials still log in', async () => {
    const res = await ctx.post('/api/friends/auth', {
      data: { username: authFriend.username, password: authFriend.password },
    })
    expect(res.status(), 'the real credentials still authenticate').toBe(200)
    const body = await res.json()
    expect(body.token, 'and still mint a friend session').toBeTruthy()
    expect(body.hasCredentials).toBe(true)
  })

  test('NOTHING LOOSENED: the legacy shared-password path is untouched', async () => {
    const res = await ctx.post('/api/friends/auth', {
      data: { password: FRIENDS_PASSWORD, friendId: authFriend.id },
    })
    expect(res.status(), 'shared-password login still works').toBe(200)
  })
})

// ── 3. POST /api/friends/:id/setup-credentials — shared friends password ─────
test.describe('FUP-T11 — POST /api/friends/:id/setup-credentials', () => {
  const setupUsername = () => uniqueUsername('fup11setup')

  for (const password of MALFORMED) {
    test(`a ${label(password)} password is a 400, never a 500`, async () => {
      const res = await ctx.post(`/api/friends/${setupFriendId}/setup-credentials`, {
        headers: shared(),
        data: { username: setupUsername(), password },
      })
      expect(res.status(), `malformed password ${label(password)} is refused cleanly`).toBe(400)
      const body = await res.json()
      expect(body.error, "the route's own message, unchanged").toBe(FRIEND_PASSWORD_TOO_SHORT)
      expect(body.field, 'this route never carried a field marker').toBeUndefined()
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: a short or absent password still 400s with the same message', async () => {
    for (const password of ['', 'short7c', undefined, null]) {
      const res = await ctx.post(`/api/friends/${setupFriendId}/setup-credentials`, {
        headers: shared(),
        data: { username: setupUsername(), password },
      })
      expect(res.status(), `short/absent password ${label(password)} still 400s`).toBe(400)
      expect((await res.json()).error).toBe(FRIEND_PASSWORD_TOO_SHORT)
    }
  })

  test('NOTHING LOOSENED: the checks that run BEFORE the password guard still win', async () => {
    // Username validation and the taken-username check both sit above the password
    // guard; a regression that moved or short-circuited the guard would show up as
    // one of these stopping to answer. Asserted with a malformed password, so the
    // ordering is the only thing under test.
    const badUsername = await ctx.post(`/api/friends/${setupFriendId}/setup-credentials`, {
      headers: shared(),
      data: { username: 'x', password: { length: 12 } },
    })
    expect(badUsername.status(), 'username validation still runs first').toBe(400)
    expect((await badUsername.json()).error, 'and answers with ITS message').toMatch(/Uzivatelske meno/)

    const taken = await ctx.post(`/api/friends/${setupFriendId}/setup-credentials`, {
      headers: shared(),
      data: { username: authFriend.username, password: { length: 12 } },
    })
    expect(taken.status(), 'the taken-username check still runs first').toBe(409)
  })

  test('NOTHING LOOSENED: valid credentials are still set and really authenticate', async () => {
    const username = setupUsername()
    const password = 'fup11SetupPass'
    const res = await ctx.post(`/api/friends/${setupFriendId}/setup-credentials`, {
      headers: shared(),
      data: { username, password },
    })
    expect(res.status(), 'a well-formed setup still succeeds').toBe(200)

    // The password that was accepted is the password that authenticates — a stored
    // hash that does not match what the person typed looks like success and locks
    // them out.
    const login = await ctx.post('/api/friends/auth', { data: { username, password } })
    expect(login.status(), 'the accepted password really logs in').toBe(200)
    const forged = await ctx.post('/api/friends/auth', { data: { username, password: 'wrongPass123' } })
    expect(forged.status(), 'and the check is real').toBe(401)
  })
})

// ── 4. PUT /api/friends/:id/reset-password — requireAdmin ────────────────────
test.describe('FUP-T11 — PUT /api/friends/:id/reset-password', () => {
  for (const password of MALFORMED) {
    test(`a ${label(password)} password is a 400, never a 500`, async () => {
      const res = await ctx.put(`/api/friends/${resetFriendId}/reset-password`, {
        headers: admin(),
        data: { password },
      })
      expect(res.status(), `malformed password ${label(password)} is refused cleanly`).toBe(400)
      const body = await res.json()
      expect(body.error, "the route's own message, unchanged").toBe(FRIEND_PASSWORD_TOO_SHORT)
      expect(body.field, 'this route never carried a field marker').toBeUndefined()
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: a short or absent password still 400s with the same message', async () => {
    for (const password of ['', 'short7c', undefined, null]) {
      const res = await ctx.put(`/api/friends/${resetFriendId}/reset-password`, {
        headers: admin(),
        data: { password },
      })
      expect(res.status(), `short/absent password ${label(password)} still 400s`).toBe(400)
      expect((await res.json()).error).toBe(FRIEND_PASSWORD_TOO_SHORT)
    }
  })

  test('NOTHING LOOSENED: the 404 for an unknown friend still runs first', async () => {
    const res = await ctx.put('/api/friends/99999999/reset-password', {
      headers: admin(),
      data: { password: { length: 12 } },
    })
    expect(res.status(), 'a malformed password must not become an existence oracle').toBe(404)
  })

  test('NOTHING LOOSENED: a valid reset still writes a working password', async () => {
    // Give the target a username first so the new password can be exercised.
    const username = uniqueUsername('fup11reset')
    const setup = await ctx.post(`/api/friends/${resetFriendId}/setup-credentials`, {
      headers: shared(),
      data: { username, password: 'fup11FirstPass' },
    })
    expect(setup.status(), 'reset fixture got a username').toBe(200)

    const password = 'fup11ResetPass'
    const res = await ctx.put(`/api/friends/${resetFriendId}/reset-password`, {
      headers: admin(),
      data: { password },
    })
    expect(res.status(), 'a well-formed reset still succeeds').toBe(200)

    const login = await ctx.post('/api/friends/auth', { data: { username, password } })
    expect(login.status(), 'the reset password really logs in').toBe(200)
    // …and the reset still forces a change, which is the whole point of the route.
    expect((await login.json()).mustChangePassword, 'must_change_password still set').toBe(true)

    const old = await ctx.post('/api/friends/auth', { data: { username, password: 'fup11FirstPass' } })
    expect(old.status(), 'and the old password really stopped working').toBe(401)
  })
})

// ── 5. POST /api/admin/change-password — BOTH inputs ─────────────────────────
test.describe('FUP-T11 — POST /api/admin/change-password', () => {
  for (const currentPassword of MALFORMED) {
    test(`a ${label(currentPassword)} currentPassword is a 401, never a 500`, async () => {
      const res = await ctx.post('/api/admin/change-password', {
        headers: admin(),
        data: { currentPassword, newPassword: 'fup11ValidNew1' },
      })
      expect(res.status(), `malformed currentPassword ${label(currentPassword)} is refused cleanly`).toBe(401)
      const body = await res.json()
      expect(body.error, "the route's own message, unchanged").toBe(ADMIN_WRONG_CURRENT)
      expectNoInternals(body)
      // …and nothing was written: the real password still works.
      await expectAdminPasswordUntouched()
    })
  }

  for (const newPassword of MALFORMED) {
    test(`a ${label(newPassword)} newPassword is a 400, never a 500`, async () => {
      const res = await ctx.post('/api/admin/change-password', {
        headers: admin(),
        data: { currentPassword: ADMIN_PASSWORD, newPassword },
      })
      expect(res.status(), `malformed newPassword ${label(newPassword)} is refused cleanly`).toBe(400)
      const body = await res.json()
      expect(body.error, "the route's own message, unchanged").toBe(ADMIN_NEW_TOO_SHORT)
      expectNoInternals(body)
      await expectAdminPasswordUntouched()
    })
  }

  test('NOTHING LOOSENED: falsy inputs still answer with the "both required" message', async () => {
    for (const data of [
      { currentPassword: '', newPassword: 'fup11ValidNew1' },
      { currentPassword: ADMIN_PASSWORD, newPassword: '' },
      { currentPassword: ADMIN_PASSWORD },
      { newPassword: 'fup11ValidNew1' },
    ]) {
      const res = await ctx.post('/api/admin/change-password', { headers: admin(), data })
      expect(res.status(), `falsy input ${JSON.stringify(data)} still 400s`).toBe(400)
      expect((await res.json()).error).toBe(ADMIN_BOTH_REQUIRED)
    }
  })

  test('NOTHING LOOSENED: a short STRING newPassword still fails the length rule', async () => {
    const res = await ctx.post('/api/admin/change-password', {
      headers: admin(),
      data: { currentPassword: ADMIN_PASSWORD, newPassword: 'short1' },
    })
    expect(res.status(), 'the length rule survived the type guard').toBe(400)
    expect((await res.json()).error).toBe(ADMIN_NEW_TOO_SHORT)
  })

  test('NOTHING LOOSENED: a wrong STRING currentPassword is still refused identically', async () => {
    const res = await ctx.post('/api/admin/change-password', {
      headers: admin(),
      data: { currentPassword: 'not-the-admin-password', newPassword: 'fup11ValidNew1' },
    })
    expect(res.status()).toBe(401)
    expect((await res.json()).error).toBe(ADMIN_WRONG_CURRENT)
  })
})

// ── The change-password round trip. Isolated in its own describe and placed LAST
// because it genuinely rewrites the SHARED admin password (and `change-password`
// deletes the single app-wide `admin_token` on success), so it restores both
// before anything else runs. Without it, "a correct password still succeeds"
// would be unproven for the one route where the hash path is the whole point.
test.describe('FUP-T11 — change-password round trip (the non-vacuity gate)', () => {
  const TEMP = 'fup11TempAdminPass'

  // ⚠ Safety net: if the round trip fails half way, the shared admin password must
  // still be ADMIN_PASSWORD when the next spec file runs, or the whole suite fails
  // at the login field for a reason that has nothing to do with it.
  test.afterAll(async () => {
    if ((await adminLogin(ADMIN_PASSWORD)).status() === 200) return
    const rescue = await adminLogin(TEMP)
    if (rescue.status() !== 200) return
    const token = (await rescue.json()).token
    await ctx.post('/api/admin/change-password', {
      headers: { 'X-Admin-Token': token },
      data: { currentPassword: TEMP, newPassword: ADMIN_PASSWORD },
    })
  })

  test('a real change still succeeds, takes effect, and can be changed back', async () => {
    const forward = await ctx.post('/api/admin/change-password', {
      headers: admin(),
      data: { currentPassword: ADMIN_PASSWORD, newPassword: TEMP },
    })
    expect(forward.status(), 'a well-formed change still succeeds').toBe(200)

    expect((await adminLogin(TEMP)).status(), 'the new password really took effect').toBe(200)
    expect((await adminLogin(ADMIN_PASSWORD)).status(), 'and the old one really stopped working').toBe(401)

    const back = await adminLogin(TEMP)
    const tempToken = (await back.json()).token
    const restore = await ctx.post('/api/admin/change-password', {
      headers: { 'X-Admin-Token': tempToken },
      data: { currentPassword: TEMP, newPassword: ADMIN_PASSWORD },
    })
    expect(restore.status(), 'and back again').toBe(200)

    const final = await adminLogin(ADMIN_PASSWORD)
    expect(final.status(), 'the shared fixture password is restored').toBe(200)
    // Re-adopt the token: `change-password` deleted the single app-wide one.
    adminToken = (await final.json()).token
  })
})

// ── The log half — the reason this row is worth more than a status correction ─
//
// Reading the server's stdout needs the backend's log path, exactly as the DB_PATH
// specs need the database: `SERVER_LOG=<path>`. A normal run reports these as
// skipped. The pattern (and `appended()`) is `image-upload.spec.js`'s FUP-T7 block.
const SERVER_LOG = process.env.SERVER_LOG
const STACK_FRAME = /^\s+at\s/m

test.describe('FUP-T11 — no stack reaches the log for the two PUBLIC routes', () => {
  test.skip(!SERVER_LOG, 'set SERVER_LOG=<backend log path> to exercise the log assertions')

  // ⚠ --workers=1 is a REQUIREMENT, not a preference (the FUP-T7 lesson): the
  // assertions read a SHARED appended file, so another file's genuine 500 landing
  // inside the before/after window would redden this — or, far worse, mask it.
  test.beforeAll(() => {
    expect(
      test.info().config.workers,
      'the log assertions read a shared appended file — run this spec with --workers=1',
    ).toBe(1)
  })

  let fs

  test.beforeAll(async () => { fs = await import('node:fs') })

  async function appended(run) {
    const before = (await fs.promises.stat(SERVER_LOG)).size
    await run()
    // The error line is written on the tick after the response.
    await new Promise((r) => setTimeout(r, 400))
    const fh = await fs.promises.open(SERVER_LOG, 'r')
    const size = (await fh.stat()).size
    const buf = Buffer.alloc(Math.max(0, size - before))
    if (buf.length) await fh.read(buf, 0, buf.length, before)
    await fh.close()
    return buf.toString('utf8')
  }

  test('an UNAUTHENTICATED admin-login flood costs no stack at all', async () => {
    const log = await appended(async () => {
      for (const password of MALFORMED) {
        const res = await adminLogin(password)
        expect(res.status(), `${label(password)} is refused cleanly`).toBe(401)
      }
    })
    expect(log, 'no stack frames on a client-triggerable branch').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from inside bcrypt').not.toMatch(/Illegal arguments|bcryptjs/i)
    // ⚠ The LEGACY branch never touches bcrypt at all — `crypto.createHash().update()`
    // raises a plain TypeError on a non-string — so a guard placed only inside
    // `comparePassword` would leave a legacy-hashed instance still logging stacks.
    expect(log, 'nor the legacy SHA-256 branch\'s own TypeError').not.toMatch(/The "data" argument/i)
  })

  test('the friend login costs no stack either', async () => {
    const log = await appended(async () => {
      for (const password of MALFORMED) {
        const res = await ctx.post('/api/friends/auth', {
          data: { username: authFriend.username, password },
        })
        expect(res.status(), `${label(password)} is refused cleanly`).toBe(401)
      }
    })
    expect(log, 'no stack frames on a client-triggerable branch').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from inside bcrypt').not.toMatch(/Illegal arguments|bcryptjs/i)
  })

  // ⚠ Counter-assertion, and it is what makes the two tests above non-vacuous.
  // Without it the whole block would be satisfied by a server that logs nothing at
  // all, or by an `appended()` window that reads the wrong file — both of which
  // would trade a log-flood for blindness to real faults.
  test('a genuine server fault still logs its full stack', async () => {
    const log = await appended(async () => {
      // A disallowed Origin is rejected with a bare Error and no status — the 500
      // branch, reachable without touching any password route at all.
      const res = await ctx.get('/api/cycles', { headers: { Origin: 'http://not-an-allowed-origin.example' } })
      expect(res.status()).toBe(500)
    })
    expect(log, 'the 500 branch keeps its stack').toMatch(STACK_FRAME)
  })
})
