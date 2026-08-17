import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// FUP-T10 — `backend/src/routes/onboarding.js`'s password guard.
//
// ⚠ THIS IS THE THIRD INSTANCE OF ONE DEFECT CLASS, not a third coincidence.
// `if (!password || password.length < 8)` reads `.length` off whatever the body
// carried, so ANY object with a `length` ≥ 8 — the reported `{"password":{"length":12}}`
// — is truthy, clears the comparison, and reaches `hashPassword`, which is
// `bcrypt.hashSync` and THROWS `Illegal arguments: object, string` on a non-string.
// The result is a 500 `Nieco sa pokazilo` plus a full stack in the server log, for a
// body that is merely malformed. ML-T6 fixed exactly this twice on `friends.js`
// (`currentPassword`, then `newPassword` one line below); the fix here is the same
// shape — `typeof password !== 'string'` — so all three sites read alike.
//
// ⚠ WHAT MAKES THIS ONE WORSE THAN THE OTHER TWO: the route is PUBLIC and
// UNAUTHENTICATED (onboarding registration — anyone holding a shared link, and the
// link token is the only thing between the internet and this handler). ML-T6's two
// both sat behind a friend session. So the stack-log half here is REMOTELY
// TRIGGERABLE BY ANYONE, which is precisely the FUP-T3/FUP-T7 rule: a client-
// triggerable branch must not cost a stack per hit, or it is a free remote
// log-flood. That is why the log assertions below are part of this row and not a
// nicety — the wrong STATUS is a bug, the stack is the abuse surface.
//
// The counter-assertions carry as much weight as the 400s: a short STRING must still
// 400 with the identical message and field marker (the guard must not become a
// type-check that forgot the length rule), an absent password — which arrives as `''`
// through the route's own `req.body.password || ''` fallback — must still 400 exactly
// as today, and a valid registration must still create a friend whose credentials
// really work. Nothing about this fix may loosen the policy; only non-strings move
// 500 → 400.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'

// The route's existing message and field marker — REUSED VERBATIM, never re-worded.
// `friends.js`'s two sibling sites answer with the same sentence, and a new string
// here would be a silent copy change on a public registration form.
const TOO_SHORT = 'Heslo musí mať aspoň 8 znakov'

// The reported shape, plus every other non-string that took the same 500 path.
// ⚠ BOTH arrays are here on purpose and they are NOT the same case. A one-element
// array has `length === 1`, so the OLD guard already refused it with a 400 — for the
// wrong reason, but a 400. The EIGHT-element one has `length === 8`, clears
// `length < 8` natively, and was a genuine 500. Keeping only the short one would have
// made this list look like it covered arrays while missing the bypass entirely.
const MALFORMED_PASSWORDS = [
  { length: 12 },
  { length: 99 },
  12345678,
  ['abcdefghij'],
  ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  true,
]

// Nothing loosened: short and absent strings keep the behaviour they have today.
// `undefined` / `null` reach the handler as `''` via `req.body.password || ''`.
const SHORT_OR_ABSENT_PASSWORDS = ['', 'short7c', undefined, null]

let ctx
let adminToken
let linkToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

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

// One registration attempt. `password` is passed through untouched — including
// `undefined`, which Playwright serialises out of the JSON body entirely, i.e. the
// genuinely-absent case.
async function register(password, overrides = {}) {
  return ctx.post(`/api/onboarding/${linkToken}`, {
    data: {
      name: `E2E FUP10 ${uniq}`,
      phone: uniquePhone(),
      username: uniqueUsername('fup10'),
      password,
      ...overrides,
    },
  })
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
  expect(adminToken, 'admin login for the link fixture').toBeTruthy()

  const created = await ctx.post('/api/onboarding-links', {
    headers: { 'X-Admin-Token': adminToken },
    data: { note: `E2E FUP10 onboarding ${uniq}` },
  })
  expect(created.status(), 'onboarding link create').toBe(201)
  linkToken = (await created.json()).token
  expect(linkToken, 'the link fixture carries a token').toBeTruthy()
})

test.afterAll(async () => { await ctx?.dispose() })

test.describe('FUP-T10 — a non-string onboarding password is a 400, never a 500', () => {
  for (const password of MALFORMED_PASSWORDS) {
    test(`POST /api/onboarding/:token with password ${JSON.stringify(password)} is a 400`, async () => {
      const res = await register(password)
      expect(
        res.status(),
        `a malformed body is a client mistake, not a server fault (${JSON.stringify(password)})`,
      ).toBe(400)

      const body = await res.json()
      // ⚠ THE EXISTING MESSAGE AND THE EXISTING FIELD MARKER. The registration form
      // renders `field` to decide which input to redden; a 400 without it would be a
      // silent UX regression even though the status is right.
      expect(body.error, 'the route\'s own Slovak message, unchanged').toBe(TOO_SHORT)
      expect(body.field, 'the field marker the form needs').toBe('password')

      // Nothing from the exception may reach the client either.
      const raw = JSON.stringify(body)
      expect(raw, 'no bcrypt internals in the response').not.toMatch(/Illegal arguments|bcrypt/i)
      expect(raw, 'no stack trace in the response').not.toMatch(/at .*\.js|node_modules/)
    })
  }

  test('NOTHING LOOSENED: a short or absent password still 400s with the same message', async () => {
    for (const password of SHORT_OR_ABSENT_PASSWORDS) {
      const res = await register(password)
      expect(
        res.status(),
        `short/absent password ${JSON.stringify(password)} still 400s`,
      ).toBe(400)
      const body = await res.json()
      expect(body.error, 'identical message for the length rule').toBe(TOO_SHORT)
      expect(body.field).toBe('password')
    }
  })

  test('NOTHING LOOSENED: a valid registration still succeeds and the credentials work', async () => {
    // The non-vacuity gate for every 400 above: if the guard had been written so
    // that it refused strings too, the whole block would still be green.
    const username = uniqueUsername('fup10ok')
    const password = 'onboardPass1'
    const res = await register(password, { username })
    expect(res.status(), 'a well-formed registration is unaffected').toBe(201)

    const body = await res.json()
    expect(body.friendId, 'a friend was really created').toBeTruthy()
    expect(body.token, 'and auto-login still mints a session').toBeTruthy()

    // The password that was accepted is the password that authenticates — a stored
    // hash that does not match what the person typed looks like success and locks
    // them out.
    const login = await ctx.post('/api/friends/auth', { data: { username, password } })
    expect(login.status(), 'the accepted password really logs in').toBe(200)

    // …and a wrong one does not, so a server that accepted anything could not pass.
    const forged = await ctx.post('/api/friends/auth', { data: { username, password: 'wrongPass123' } })
    expect(forged.status(), 'the login check is real').toBe(401)
  })

  test('NOTHING LOOSENED: the guard did not swallow the checks that run before it', async () => {
    // The password guard sits between `validateUsername` and `isUsernameTaken`, so a
    // regression that moved or short-circuited it would show up as one of these
    // stopping to answer. All three are asserted with a VALID password, so the only
    // thing under test is the ordering around the guard.
    const missingName = await register('onboardPass1', { name: '' })
    expect(missingName.status(), 'name is still required').toBe(400)
    expect((await missingName.json()).field).toBe('name')

    const missingPhone = await register('onboardPass1', { phone: '' })
    expect(missingPhone.status(), 'phone is still required').toBe(400)
    expect((await missingPhone.json()).field).toBe('phone')

    const badUsername = await register('onboardPass1', { username: 'x' })
    expect(badUsername.status(), 'username validation still runs BEFORE the password guard').toBe(400)
    expect((await badUsername.json()).field).toBe('username')
  })

  test('an unknown link token is still a 404, whatever the password shape', async () => {
    // The malformed password must not become a way to tell a live link from a dead
    // one: the link lookup runs first and still wins.
    const res = await ctx.post('/api/onboarding/definitely-not-a-real-token', {
      data: { name: 'X', phone: uniquePhone(), username: uniqueUsername('ghost'), password: { length: 12 } },
    })
    expect(res.status(), 'the link check still runs first').toBe(404)
  })
})

// ── The log half — the reason this row is worth more than a status correction ──
//
// Reading the server's stdout needs the backend's log path, exactly as the DB_PATH
// specs need the database: `SERVER_LOG=<path>`. A normal run reports these as
// skipped. The pattern (and `appended()`) is `image-upload.spec.js`'s FUP-T7 block.
const SERVER_LOG = process.env.SERVER_LOG
const STACK_FRAME = /^\s+at\s/m

test.describe('FUP-T10 — no stack reaches the log for a malformed password', () => {
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

  test('a non-string password costs no stack — an unauthenticated caller cannot flood the log', async () => {
    const log = await appended(async () => {
      for (const password of MALFORMED_PASSWORDS) {
        const res = await register(password)
        expect(res.status(), `${JSON.stringify(password)} is refused cleanly`).toBe(400)
      }
    })
    expect(log, 'no stack frames on a client-triggerable branch').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from inside bcrypt').not.toMatch(/Illegal arguments|bcryptjs/i)
  })

  // ⚠ Counter-assertion, and it is what makes the test above non-vacuous. Without
  // it the whole block would be satisfied by a server that logs nothing at all, or
  // by an `appended()` window that reads the wrong file — both of which would trade
  // a log-flood for blindness to real faults.
  test('a genuine server fault still logs its full stack', async () => {
    const log = await appended(async () => {
      // A disallowed Origin is rejected with a bare Error and no status — the 500
      // branch, reachable without touching the onboarding routes at all.
      const res = await ctx.get('/api/cycles', { headers: { Origin: 'http://not-an-allowed-origin.example' } })
      expect(res.status()).toBe(500)
    })
    expect(log, 'the 500 branch keeps its stack').toMatch(STACK_FRAME)
  })
})
