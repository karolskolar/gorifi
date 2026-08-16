import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'

// FUP-T12 — the SECOND non-string body class: a STRING METHOD called on an
// unvalidated request-body field.
//
// ⚠ THIS IS NOT THE BCRYPT CLASS AND FUP-T11's HELPER GUARD CANNOT SEE IT.
// FUP-T11 closed every `bcrypt.compareSync`/`hashSync` reached without a
// `typeof … === 'string'` guard. This row closes the sites where the throw comes
// from a LANGUAGE BUILTIN instead — `.toLowerCase()`, `.trim()`, `.substring()`,
// `.match()` on whatever the body happened to carry. `({toLowerCase: 1}).toLowerCase()`
// is "1 is not a function"; `(123).trim` is `undefined`; both are a TypeError, i.e.
// a 500 `Nieco sa pokazilo` plus a FULL STACK IN THE SERVER LOG for a body that is
// merely malformed.
//
// ⚠ WHY IT IS THE SAME ABUSE SURFACE: `POST /api/friends/auth` with
// `{"username":{"toLowerCase":1}}` is unauthenticated and appended 677 bytes of stack
// PER REQUEST (orchestrator-reproduced), and `POST /api/onboarding/:token` — the
// public registration form — did the same on FOUR of its fields. That is the
// FUP-T3/FUP-T7 rule verbatim: a client-triggerable branch must not cost a stack per
// hit, or it is a free remote log-flood. The wrong STATUS is the bug; the stack is
// the abuse surface.
//
// ⚠ THE SWEEP FOUND 20 LIVE SITES ACROSS 7 FILES where the row expected one. The
// naive grep (`req.body.x.trim()`) finds essentially nothing, because this codebase
// DESTRUCTURES first and then calls methods on the local binding. Every live site is
// asserted below, grouped by route.
//
// ⚠ TWO OF THE TWENTY WERE FOUND BY THIS ROW'S REVIEW, AFTER THE FIRST SWEEP CLEARED
// THEM AS SAFE — both in the file the row had already hardened, both because
// `String(x)` / `x.toString()` were read as coercion guards. They are not: ToPrimitive
// CALLS `toString`, so `?u[toString]=1` and `{"note":{"toString":1}}` throw. One of
// them (`GET /onboarding/:token/check-username`) is public AND has no rate limiter at
// all, making it a cheaper flood than the instance this row was opened for. That is
// why `{toString:1}` is in the matrix below and why "the shape list is the sweep" is
// false — a site can be invisible to every shape but one.
//
// ⚠ NOTHING MAY LOOSEN. Each block carries counter-assertions: the field's existing
// refusal must still fire for an empty/absent string, a well-formed request must
// still succeed, and where the malformed value is IGNORED rather than refused (the
// two optional free-text fields that never had a rule of their own) the stored value
// must be proved UNCHANGED — a guard that coerced them to NULL would silently wipe
// real data while every status assertion stayed green.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'

// ── Route messages, REUSED VERBATIM from the handlers. A new string here would be a
// silent copy change on a public screen, so these are copied, never re-worded.
const FRIEND_BAD_CREDENTIALS = 'Nesprávne prihlasovacie údaje'
const ONB_NAME_REQUIRED = 'Meno je povinné'
const ONB_PHONE_REQUIRED = 'Mobil je povinný'
const ONB_EMAIL_INVALID = 'Neplatný email'
const ONB_USERNAME_REQUIRED = 'Uzivatelske meno je povinne'
const LINK_NOTE_REQUIRED = 'Popis je povinný'
const LINK_NOTE_EMPTY = 'Popis nemôže byť prázdny'
const PROFILE_NAME_REQUIRED = 'Prihlasovacie meno je povinné'
const PARCEL_ADDRESS_REQUIRED = 'Adresa výdajného miesta je povinná'
const PICKUP_NAME_REQUIRED = 'Názov je povinný'
const ROASTERY_NAME_REQUIRED = 'Názov pražiarne je povinný'
const TX_NOTE_REQUIRED = 'Dôvod (poznámka) je povinný'
const TX_NOTHING_TO_UPDATE = 'Žiadne údaje na aktualizáciu'
const IMPORT_URL_REQUIRED = 'URL je povinne'
const IMPORT_URL_INVALID = 'Neplatna Google Sheets URL'

// ⚠ THE SHAPE MATRIX, and every entry earns its place (the FUP-T11 trap).
//   • `{toLowerCase:1}` / `{trim:1}` — the reported shapes: the METHOD EXISTS but is
//     not callable, so a `value && value.trim` style guard would still let them past.
//   • `{length:12}` — clears every `length` rule in the app natively.
//   • a number and `true` — `.trim` is `undefined`, so `undefined(…)` throws; these
//     are the two that a bare length comparison waves straight through.
//   • a MULTI-element array — a ONE-element array has `length === 1` and therefore
//     already 400'd by accident on the length-ruled routes, so a suite carrying only
//     that shape passes vacuously. Both are here; the three-element one is the real
//     probe on routes with no length rule at all.
//   • `{toString:1}` — added by this row's REVIEW, and it is the shape that exposed
//     the two sites the first sweep cleared as safe. `String(x)` and `x.toString()`
//     look like coercion guards but are not: ToPrimitive CALLS `toString`, so a
//     non-callable `toString` property throws `Cannot convert object to primitive
//     value`. A matrix without it reports those sites as clean.
const MALFORMED = [
  { toLowerCase: 1 },
  { trim: 1 },
  { toString: 1 },
  { length: 12 },
  12345678901234,
  ['abcdefghijkl'],
  ['a', 'b', 'c'],
  true,
]

const label = (v) => JSON.stringify(v)

// Nothing from the exception may reach the client either — a 400 that echoed
// `url.match is not a function` would be a different leak with a nicer status.
// (That one is not hypothetical: the two Google-Sheets import routes answered 400
// with exactly that sentence, because their own try/catch caught the TypeError.)
function expectNoInternals(body) {
  const raw = JSON.stringify(body)
  expect(raw, 'no internals in the response').not.toMatch(
    /is not a function|Cannot read|TypeError/i,
  )
  expect(raw, 'no stack trace in the response').not.toMatch(/at .*\.js|node_modules/)
}

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
let seq = 0
const nextSeq = () => ++seq
const uniqueUsername = (prefix) =>
  `${prefix}${uniq}${nextSeq()}`.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30)
const phoneSeed = String(Date.now()).slice(-8)
const uniquePhone = () => `09${phoneSeed}${String(nextSeq()).padStart(2, '0')}`

let ctx
let adminToken
let linkToken
let patchLinkId
// A friend with real credentials — the /friends/auth and profile fixture.
let authFriend
let friendBearer
// A parcel-enabled cycle with one product and a draft order — the orders/submit fixture.
let parcelCycleId
let parcelFriendId
// Fixtures for the admin write routes.
let pickupId
let roasteryId
let transactionId
let importCycleId

const admin = () => ({ 'X-Admin-Token': adminToken })
const shared = () => ({ 'X-Friends-Password': FRIENDS_PASSWORD })
const bearer = () => ({ Authorization: `Bearer ${friendBearer}` })

async function createFriend(name) {
  const res = await ctx.post('/api/friends', { headers: admin(), data: { name: `FUP12 ${name} ${uniq}` } })
  expect(res.status(), `friend fixture ${name} created`).toBe(201)
  return (await res.json()).id
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })

  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login for the fixtures').toBe(200)
  adminToken = (await login.json()).token

  // A friend who really can log in. `setup-credentials` is the only friend-side
  // route that mints a username/password pair.
  const id = await createFriend('auth')
  const username = uniqueUsername('fup12auth')
  const password = 'fup12AuthPass'
  const setup = await ctx.post(`/api/friends/${id}/setup-credentials`, {
    headers: shared(),
    data: { username, password },
  })
  expect(setup.status(), 'the /friends/auth fixture got credentials').toBe(200)
  authFriend = { id, username, password }
  friendBearer = (await setup.json()).token

  const createdLink = await ctx.post('/api/onboarding-links', {
    headers: admin(),
    data: { note: `FUP12 onboarding ${uniq}` },
  })
  expect(createdLink.status(), 'onboarding link fixture').toBe(201)
  linkToken = (await createdLink.json()).token

  // ⚠ A SEPARATE link for the PATCH block, never registered against. The registration
  // tests above create friends whose `onboarding_source` is the first link's note, and
  // the route refuses to rename a link that has registrations ("audit pôvodu") — so
  // reusing it would make the "a real note still updates" counter-assertion fail for a
  // reason that has nothing to do with this fix.
  const patchLink = await ctx.post('/api/onboarding-links', {
    headers: admin(),
    data: { note: `FUP12 patch target ${uniq}` },
  })
  expect(patchLink.status(), 'onboarding link PATCH fixture').toBe(201)
  patchLinkId = (await patchLink.json()).id

  // Parcel delivery fixture: a coffee cycle with `parcel_enabled`, one product and a
  // draft cart, so the submit handler really reaches its packeta branch.
  const cycle = await ctx.post('/api/cycles', {
    headers: admin(),
    data: { name: `FUP12 parcel ${uniq}`, cycle_type: 'coffee' },
  })
  expect(cycle.status(), 'parcel cycle fixture').toBe(201)
  parcelCycleId = (await cycle.json()).id
  const enabled = await ctx.patch(`/api/cycles/${parcelCycleId}`, {
    headers: admin(),
    data: { parcel_enabled: 1, parcel_fee: 2 },
  })
  expect((await enabled.json()).parcel_enabled, 'parcel delivery is really on').toBe(1)
  const product = await ctx.post('/api/products', {
    headers: admin(),
    data: { cycle_id: parcelCycleId, name: `FUP12 Coffee ${uniq}`, price_250g: 10, purpose: 'Filter' },
  })
  expect(product.status(), 'product fixture').toBe(201)
  parcelFriendId = await createFriend('parcel')
  const cart = await ctx.put(`/api/orders/cycle/${parcelCycleId}/friend/${parcelFriendId}`, {
    headers: shared(),
    data: { items: [{ product_id: (await product.json()).id, variant: '250g', quantity: 1 }] },
  })
  expect(cart.status(), 'draft cart fixture').toBe(200)

  const pickup = await ctx.post('/api/pickup-locations', {
    headers: admin(),
    data: { name: `FUP12 pickup ${uniq}`, address: 'Pôvodná adresa 1' },
  })
  expect(pickup.status(), 'pickup location fixture').toBe(201)
  pickupId = (await pickup.json()).id

  const roastery = await ctx.post('/api/roasteries', {
    headers: admin(),
    data: { name: `FUP12 roastery ${uniq}` },
  })
  expect(roastery.status(), 'roastery fixture').toBe(201)
  roasteryId = (await roastery.json()).id

  const tx = await ctx.post('/api/transactions/adjustment', {
    headers: admin(),
    data: { friend_id: authFriend.id, amount: 1, note: 'FUP12 pôvodná poznámka' },
  })
  expect(tx.status(), 'transaction fixture').toBe(201)
  transactionId = (await tx.json()).transaction.id

  const importCycle = await ctx.post('/api/cycles', {
    headers: admin(),
    data: { name: `FUP12 import ${uniq}`, cycle_type: 'coffee' },
  })
  expect(importCycle.status(), 'import cycle fixture').toBe(201)
  importCycleId = (await importCycle.json()).id
})

test.afterAll(async () => { await ctx?.dispose() })

// ── 1. POST /api/friends/auth — PUBLIC, the reported site ────────────────────
//
// ⚠ IT MUST ANSWER 401, NOT 400, AND THE MESSAGE MUST BE THE ROUTE'S EXISTING ONE.
// FUP-T11 REMOVED a username-existence oracle from this very endpoint (a malformed
// password used to answer 500 for a known username and 401 for an unknown one). A
// distinct status or sentence for "your username was not a string" would put a new
// one back — so a non-string username is refused exactly like a username that does
// not exist, byte for byte.
test.describe('FUP-T12 — POST /api/friends/auth with a non-string username', () => {
  for (const username of MALFORMED) {
    test(`username ${label(username)} is a 401, never a 500`, async () => {
      const res = await ctx.post('/api/friends/auth', { data: { username, password: 'whatever' } })
      expect(
        res.status(),
        `a malformed body is a client mistake, not a server fault (${label(username)})`,
      ).toBe(401)
      const body = await res.json()
      expect(body.error, "the route's own message, unchanged").toBe(FRIEND_BAD_CREDENTIALS)
      expect(body.field, 'this route never carried a field marker').toBeUndefined()
      expectNoInternals(body)
    })
  }

  test('NO NEW ORACLE: the refusal is indistinguishable from an unknown username', async () => {
    // Same status, same body AND the same headers — a differing Content-Length or
    // ETag would be as good an oracle as a differing sentence.
    const ghost = await ctx.post('/api/friends/auth', {
      data: { username: uniqueUsername('nosuchuser'), password: 'whatever' },
    })
    expect(ghost.status()).toBe(401)
    const ghostBody = await ghost.text()
    const ghostHeaders = ghost.headers()

    for (const username of MALFORMED) {
      const res = await ctx.post('/api/friends/auth', { data: { username, password: 'whatever' } })
      expect(res.status(), `same status as an unknown username (${label(username)})`).toBe(ghost.status())
      expect(await res.text(), `same body (${label(username)})`).toBe(ghostBody)
      const headers = res.headers()
      expect(headers['content-length'], `same Content-Length (${label(username)})`)
        .toBe(ghostHeaders['content-length'])
      expect(headers['etag'], `same ETag (${label(username)})`).toBe(ghostHeaders['etag'])
    }
  })

  test('NOTHING LOOSENED: the real credentials still log in', async () => {
    // The non-vacuity gate for every 401 above: a guard written as "refuse
    // everything" would have satisfied the whole block.
    const res = await ctx.post('/api/friends/auth', {
      data: { username: authFriend.username, password: authFriend.password },
    })
    expect(res.status(), 'the real username/password pair still works').toBe(200)
    expect((await res.json()).token, 'and still mints a session').toBeTruthy()
  })

  test('NOTHING LOOSENED: a wrong password for a real username is still 401', async () => {
    const res = await ctx.post('/api/friends/auth', {
      data: { username: authFriend.username, password: 'definitely-wrong' },
    })
    expect(res.status()).toBe(401)
    expect((await res.json()).error).toBe(FRIEND_BAD_CREDENTIALS)
  })

  test('NOTHING LOOSENED: an absent/empty username still takes the shared-password path', async () => {
    // ⚠ THE ONE THING THE GUARD MUST NOT DO. `if (username)` is the BRANCH SELECTOR
    // for personal login; turning it into `typeof username === 'string'` would send a
    // non-string body down the SHARED-PASSWORD path instead, so
    // `{username: 123, password: <shared password>}` would AUTHENTICATE. Falsy values
    // must keep falling through, non-strings must not.
    for (const username of ['', undefined, null, 0, false]) {
      const res = await ctx.post('/api/friends/auth', {
        data: { username, password: FRIENDS_PASSWORD, friendId: authFriend.id },
      })
      expect(res.status(), `falsy username ${label(username)} still uses the shared password`).toBe(200)
    }
  })

  test('NOTHING LOOSENED: a non-string username cannot borrow the shared password', async () => {
    for (const username of MALFORMED) {
      const res = await ctx.post('/api/friends/auth', {
        data: { username, password: FRIENDS_PASSWORD, friendId: authFriend.id },
      })
      expect(
        res.status(),
        `${label(username)} must NOT fall through to the shared-password branch`,
      ).toBe(401)
    }
  })
})

// ── 2. POST /api/onboarding/:token — PUBLIC registration, FOUR fields ────────
test.describe('FUP-T12 — POST /api/onboarding/:token with a non-string text field', () => {
  const register = (overrides) =>
    ctx.post(`/api/onboarding/${linkToken}`, {
      data: {
        name: `FUP12 Onb ${uniq}`,
        phone: uniquePhone(),
        username: uniqueUsername('fup12onb'),
        password: 'onboardPass1',
        ...overrides,
      },
    })

  // ⚠ Each field keeps its OWN message and field marker — the registration form
  // reddens the offending input from `field`, so a single generic 400 would be a
  // silent UX regression even with the right status. This is the FUP-T11 lesson
  // about helper guards that collapse distinct replies into one.
  const FIELDS = [
    ['name', ONB_NAME_REQUIRED],
    ['phone', ONB_PHONE_REQUIRED],
    // ⚠ email is the SUBTLE one. It is OPTIONAL, so a guard that mapped a non-string
    // to `''` would ACCEPT the registration with no e-mail — turning a refusal into a
    // 201. It must land on the route's own `Neplatný email` instead.
    ['email', ONB_EMAIL_INVALID],
    ['username', ONB_USERNAME_REQUIRED],
  ]

  for (const [field, message] of FIELDS) {
    test(`a non-string ${field} is a 400 with its own message`, async () => {
      for (const value of MALFORMED) {
        const res = await register({ [field]: value })
        expect(res.status(), `${field}=${label(value)} is a 400, not a 500`).toBe(400)
        const body = await res.json()
        expect(body.error, `${field}=${label(value)} keeps the route's own message`).toBe(message)
        expect(body.field, `${field}=${label(value)} keeps its field marker`).toBe(field)
        expectNoInternals(body)
      }
    })
  }

  test('NOTHING LOOSENED: absent/empty fields still answer exactly as today', async () => {
    const empty = await register({ name: '' })
    expect(empty.status()).toBe(400)
    expect((await empty.json()).error).toBe(ONB_NAME_REQUIRED)

    const noPhone = await register({ phone: '' })
    expect(noPhone.status()).toBe(400)
    expect((await noPhone.json()).error).toBe(ONB_PHONE_REQUIRED)

    const badEmail = await register({ email: 'not-an-address' })
    expect(badEmail.status()).toBe(400)
    expect((await badEmail.json()).error).toBe(ONB_EMAIL_INVALID)

    const shortUsername = await register({ username: 'x' })
    expect(shortUsername.status()).toBe(400)
    expect((await shortUsername.json()).field).toBe('username')
  })

  test('NOTHING LOOSENED: a valid registration still succeeds — with and without an email', async () => {
    // Non-vacuity for the whole block: a guard that refused strings too would have
    // satisfied every 400 above.
    const withEmail = await register({ email: `fup12.${uniq}@example.test` })
    expect(withEmail.status(), 'a well-formed registration is unaffected').toBe(201)
    expect((await withEmail.json()).friendId, 'a friend was really created').toBeTruthy()

    // ⚠ An ABSENT optional e-mail must still be accepted — the fix must refuse a
    // non-string without also refusing "no e-mail at all".
    const withoutEmail = await register({})
    expect(withoutEmail.status(), 'an absent optional e-mail is still fine').toBe(201)

    // …and an explicitly empty one, which the route's own `|| ''` fallback flattened.
    const emptyEmail = await register({ email: '' })
    expect(emptyEmail.status(), "an empty e-mail is still 'no e-mail'").toBe(201)
  })
})

// ── 3. POST /api/onboarding-links — admin, the link description ──────────────
test.describe('FUP-T12 — POST /api/onboarding-links with a non-string note', () => {
  for (const note of MALFORMED) {
    test(`note ${label(note)} is a 400`, async () => {
      const res = await ctx.post('/api/onboarding-links', { headers: admin(), data: { note } })
      expect(res.status(), `${label(note)} is a client mistake`).toBe(400)
      const body = await res.json()
      expect(body.error, "the route's own message").toBe(LINK_NOTE_REQUIRED)
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: an empty note still 400s and a real one still creates a link', async () => {
    const blank = await ctx.post('/api/onboarding-links', { headers: admin(), data: { note: '   ' } })
    expect(blank.status()).toBe(400)
    expect((await blank.json()).error).toBe(LINK_NOTE_REQUIRED)

    const ok = await ctx.post('/api/onboarding-links', {
      headers: admin(),
      data: { note: `FUP12 still works ${uniq}` },
    })
    expect(ok.status(), 'a well-formed note still creates the link').toBe(201)
    expect((await ok.json()).token).toBeTruthy()
  })
})

// ── 3b. GET /api/onboarding/:token/check-username — PUBLIC, NO RATE LIMITER ──
//
// ⚠ FOUND BY THIS ROW'S REVIEW, and it is the cheapest log-flood in the app. The
// handler read `(req.query.u || '').toString().toLowerCase()`, which LOOKS coerced but
// is not: Express's extended query parser turns `?u[toString]=1` into the object
// `{toString: '1'}`, whose `toString` is a string rather than a function, so the call
// threw ⇒ 500 + a 10-frame stack (1156 bytes measured), from an unauthenticated GET.
// Unlike the registration POST (`abuseLimiter`) and `/friends/auth` (`authLimiter`),
// this route is mounted BARE — there is no bucket to exhaust.
//
// ⚠ THE SHAPE MATRIX ALONE WOULD NOT HAVE CAUGHT IT: `?u=abc` and `?u[0]=a&u[1]=b`
// both answer 200. Only `{toString:1}` reaches the throw, which is why it is now in
// MALFORMED and why the query cases are spelled out here as raw bracket syntax.
test.describe('FUP-T12 — GET check-username with a non-string ?u', () => {
  const check = (query) => ctx.get(`/api/onboarding/${linkToken}/check-username?${query}`)

  // Every shape Express can produce for `?u=` that is not a string.
  const QUERY_SHAPES = [
    'u[toString]=1',
    'u[toLowerCase]=1',
    'u[trim]=1',
    'u[length]=12',
    'u[0]=a&u[1]=b',
    'u[]=a&u[]=b&u[]=c',
    'u[deep][deeper]=1',
  ]

  for (const query of QUERY_SHAPES) {
    test(`?${query} is a 200 refusal, never a 500`, async () => {
      const res = await check(query)
      expect(res.status(), `?${query} is a client mistake, not a server fault`).toBe(200)
      const body = await res.json()
      // ⚠ THE SHIPPED CONTRACT IS PRESERVED: this endpoint answers 200 with a verdict,
      // so a 400 here would be a new shape for the form to handle. `reason` is
      // `validateUsername`'s own existing sentence — no new string.
      expect(body.available, 'a malformed query can NEVER report a name as available')
        .toBe(false)
      expect(body.reason, "validateUsername's own message").toBe(ONB_USERNAME_REQUIRED)
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: real, taken, absent and malformed names all still answer correctly', async () => {
    // A free name is still available…
    const free = uniqueUsername('fup12free')
    const ok = await check(`u=${free}`)
    expect(ok.status()).toBe(200)
    expect((await ok.json()).available, 'a free username is still available').toBe(true)

    // …a TAKEN one is still refused, which is the non-vacuity gate: a guard that
    // short-circuited everything to `available:false` would satisfy the block above.
    const taken = await check(`u=${authFriend.username}`)
    expect((await taken.json()).available, 'a taken username is still unavailable').toBe(false)

    // …an absent/empty `u` keeps its exact previous answer.
    for (const query of ['', 'u=']) {
      const res = await check(query)
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.available).toBe(false)
      expect(body.reason).toBe(ONB_USERNAME_REQUIRED)
    }

    // …and the link gate still runs FIRST, so a malformed query cannot be used to
    // tell a live onboarding link from a dead one.
    const ghost = await ctx.get('/api/onboarding/definitely-not-a-real-token/check-username?u[toString]=1')
    expect(ghost.status(), 'the link lookup still wins').toBe(404)
  })
})

// ── 3c. PATCH /api/onboarding-links/:id — the second `String()` site ─────────
//
// ⚠ ALSO FOUND BY THE REVIEW, and `String(x)` failed in BOTH directions here.
// `{"note":{"toString":1}}` threw `Cannot convert object to primitive value` ⇒ 500 +
// 1081 bytes. And every OTHER non-string was silently ACCEPTED and stringified into
// the row: `{}` stored the literal `"[object Object]"`, `["a","b"]` stored `"a,b"`.
// The write half is the worse one — `note` is the onboarding PROVENANCE label that
// `getRegistrationCount()` matches against `friends.onboarding_source`, and the
// route's own "Link má registrácie" guard exists to protect exactly that trail.
test.describe('FUP-T12 — PATCH /api/onboarding-links/:id with a non-string note', () => {
  const readLink = async (id) => {
    const list = await ctx.get('/api/onboarding-links', { headers: admin() })
    return (await list.json()).find((l) => l.id === id)
  }

  test('every non-string note is a 400 and the stored note is UNCHANGED', async () => {
    const before = await readLink(patchLinkId)
    expect(before.note, 'the fixture note is really there').toBe(`FUP12 patch target ${uniq}`)

    for (const note of MALFORMED) {
      const res = await ctx.patch(`/api/onboarding-links/${patchLinkId}`, {
        headers: admin(),
        data: { note },
      })
      expect(res.status(), `${label(note)} is a client mistake`).toBe(400)
      expect((await res.json()).error, "the route's own message").toBe(LINK_NOTE_EMPTY)
    }

    // ⚠ The assertion that matters: no `"[object Object]"`, no `"a,b"`, no `"true"`.
    const after = await readLink(patchLinkId)
    expect(after.note, 'a malformed note must not be stringified into the audit column')
      .toBe(`FUP12 patch target ${uniq}`)
  })

  test('NOTHING LOOSENED: blank still 400s, a real note still saves, other fields still patch', async () => {
    const blank = await ctx.patch(`/api/onboarding-links/${patchLinkId}`, {
      headers: admin(),
      data: { note: '   ' },
    })
    expect(blank.status()).toBe(400)
    expect((await blank.json()).error).toBe(LINK_NOTE_EMPTY)

    const renamed = `FUP12 patched ${uniq}`
    const ok = await ctx.patch(`/api/onboarding-links/${patchLinkId}`, {
      headers: admin(),
      data: { note: renamed },
    })
    expect(ok.status(), 'a well-formed note still saves').toBe(200)
    expect((await readLink(patchLinkId)).note).toBe(renamed)

    // The note guard must not have swallowed the rest of the handler.
    const toggled = await ctx.patch(`/api/onboarding-links/${patchLinkId}`, {
      headers: admin(),
      data: { active: 0 },
    })
    expect(toggled.status(), 'the active toggle still works on its own').toBe(200)
    expect((await readLink(patchLinkId)).active).toBe(0)
    await ctx.patch(`/api/onboarding-links/${patchLinkId}`, { headers: admin(), data: { active: 1 } })
  })
})

// ── 4. PATCH /api/friends/:id/profile — friend-owned ─────────────────────────
test.describe('FUP-T12 — PATCH /api/friends/:id/profile with non-string text', () => {
  for (const name of MALFORMED) {
    test(`name ${label(name)} is a 400`, async () => {
      const res = await ctx.patch(`/api/friends/${authFriend.id}/profile`, {
        headers: bearer(),
        data: { name },
      })
      expect(res.status(), `${label(name)} is a client mistake`).toBe(400)
      const body = await res.json()
      expect(body.error, 'module 03\'s pinned message, unchanged').toBe(PROFILE_NAME_REQUIRED)
      expectNoInternals(body)
    })
  }

  test('an explicit null name is a 400 too, not a 500', async () => {
    // `null !== undefined` is true, so `null.trim()` was reached — the one falsy
    // value that took the crash path on this route.
    const res = await ctx.patch(`/api/friends/${authFriend.id}/profile`, {
      headers: bearer(),
      data: { name: null },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe(PROFILE_NAME_REQUIRED)
  })

  test('NOTHING LOOSENED: a blank name still 400s and a real one still saves', async () => {
    const blank = await ctx.patch(`/api/friends/${authFriend.id}/profile`, {
      headers: bearer(),
      data: { name: '   ' },
    })
    expect(blank.status()).toBe(400)
    expect((await blank.json()).error).toBe(PROFILE_NAME_REQUIRED)

    const ok = await ctx.patch(`/api/friends/${authFriend.id}/profile`, {
      headers: bearer(),
      data: { name: `FUP12 Renamed ${uniq}` },
    })
    expect(ok.status(), 'a well-formed rename still works').toBe(200)
    expect((await ok.json()).name).toBe(`FUP12 Renamed ${uniq}`)
  })

  // ⚠ `packeta_address` has NO rule of its own on this route — there is no existing
  // message to refuse with, and the row forbids inventing one. So a non-string is
  // treated as if the KEY WERE ABSENT: the write is skipped and the request succeeds.
  // The assertion that matters is therefore the STORED VALUE, not the status: a guard
  // written as `typeof x === 'string' ? x.trim() : null` would answer 200 here and
  // silently WIPE a real delivery address.
  test('a non-string packeta_address is ignored and the stored address is UNCHANGED', async () => {
    const address = `Packeta ${uniq}, Bratislava`
    const seed = await ctx.patch(`/api/friends/${authFriend.id}/profile`, {
      headers: bearer(),
      data: { packeta_address: address },
    })
    expect(seed.status(), 'the address fixture is stored').toBe(200)
    expect((await seed.json()).packeta_address).toBe(address)

    for (const value of MALFORMED) {
      const res = await ctx.patch(`/api/friends/${authFriend.id}/profile`, {
        headers: bearer(),
        data: { packeta_address: value },
      })
      expect(res.status(), `${label(value)} is not a server fault`).toBe(200)
      expect(
        (await res.json()).packeta_address,
        `${label(value)} must NOT overwrite a real address`,
      ).toBe(address)
    }
  })

  test('NOTHING LOOSENED: an explicit null packeta_address still CLEARS it', async () => {
    // The shipped clear-by-null convention. A guard that folded `null` in with the
    // non-strings would have taken the only way to remove an address.
    const seeded = await ctx.patch(`/api/friends/${authFriend.id}/profile`, {
      headers: bearer(),
      data: { packeta_address: `Clear me ${uniq}` },
    })
    expect((await seeded.json()).packeta_address).toBe(`Clear me ${uniq}`)

    const cleared = await ctx.patch(`/api/friends/${authFriend.id}/profile`, {
      headers: bearer(),
      data: { packeta_address: null },
    })
    expect(cleared.status()).toBe(200)
    expect((await cleared.json()).packeta_address, 'null still clears the address').toBeNull()
  })
})

// ── 5. POST /api/orders/cycle/:c/friend/:f/submit — the parcel address ───────
test.describe('FUP-T12 — order submit with a non-string packeta_address', () => {
  for (const packeta_address of MALFORMED) {
    test(`packeta_address ${label(packeta_address)} is a 400`, async () => {
      const res = await ctx.post(`/api/orders/cycle/${parcelCycleId}/friend/${parcelFriendId}/submit`, {
        headers: shared(),
        data: { use_parcel_delivery: true, packeta_address },
      })
      expect(res.status(), `${label(packeta_address)} is a client mistake`).toBe(400)
      const body = await res.json()
      expect(body.error, "the route's own message").toBe(PARCEL_ADDRESS_REQUIRED)
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: an empty address still 400s and a real one still submits', async () => {
    const blank = await ctx.post(`/api/orders/cycle/${parcelCycleId}/friend/${parcelFriendId}/submit`, {
      headers: shared(),
      data: { use_parcel_delivery: true, packeta_address: '   ' },
    })
    expect(blank.status()).toBe(400)
    expect((await blank.json()).error).toBe(PARCEL_ADDRESS_REQUIRED)

    const ok = await ctx.post(`/api/orders/cycle/${parcelCycleId}/friend/${parcelFriendId}/submit`, {
      headers: shared(),
      data: { use_parcel_delivery: true, packeta_address: `Packeta point ${uniq}` },
    })
    expect(ok.status(), 'a well-formed parcel submit still works').toBe(200)
    const order = (await ok.json()).order
    expect(order.status, 'and really submits the order').toBe('submitted')
    expect(order.packeta_address, 'with the address stored').toBe(`Packeta point ${uniq}`)
  })
})

// ── 6. /api/pickup-locations — admin ────────────────────────────────────────
test.describe('FUP-T12 — pickup locations with non-string text', () => {
  for (const name of MALFORMED) {
    test(`POST name ${label(name)} is a 400`, async () => {
      const res = await ctx.post('/api/pickup-locations', { headers: admin(), data: { name } })
      expect(res.status()).toBe(400)
      expect((await res.json()).error).toBe(PICKUP_NAME_REQUIRED)
    })
  }

  test('PATCH with a non-string name is a 400', async () => {
    for (const name of MALFORMED) {
      const res = await ctx.patch(`/api/pickup-locations/${pickupId}`, { headers: admin(), data: { name } })
      expect(res.status(), `${label(name)} is a client mistake`).toBe(400)
      expect((await res.json()).error).toBe(PICKUP_NAME_REQUIRED)
    }
  })

  test('a non-string address is ignored on create and on update', async () => {
    // Same reasoning as `packeta_address`: no rule of its own, so "as if absent".
    for (const address of MALFORMED) {
      const created = await ctx.post('/api/pickup-locations', {
        headers: admin(),
        data: { name: `FUP12 addr ${uniq}${nextSeq()}`, address },
      })
      expect(created.status(), `${label(address)} is not a server fault`).toBe(201)
      expect((await created.json()).address, 'a malformed address is stored as none').toBeNull()
    }

    // …and on PATCH it must not WIPE the address already there.
    const listBefore = await ctx.get('/api/pickup-locations/all', { headers: admin() })
    const original = (await listBefore.json()).find((l) => l.id === pickupId)
    expect(original.address, 'the fixture really has an address').toBe('Pôvodná adresa 1')

    for (const address of MALFORMED) {
      const res = await ctx.patch(`/api/pickup-locations/${pickupId}`, { headers: admin(), data: { address } })
      expect(res.status(), `${label(address)} is not a server fault`).toBe(200)
    }
    const listAfter = await ctx.get('/api/pickup-locations/all', { headers: admin() })
    expect(
      (await listAfter.json()).find((l) => l.id === pickupId).address,
      'a malformed address must NOT wipe a real one',
    ).toBe('Pôvodná adresa 1')
  })

  test('NOTHING LOOSENED: blank names still 400 and real values still write', async () => {
    const blank = await ctx.post('/api/pickup-locations', { headers: admin(), data: { name: '  ' } })
    expect(blank.status()).toBe(400)
    expect((await blank.json()).error).toBe(PICKUP_NAME_REQUIRED)

    const ok = await ctx.patch(`/api/pickup-locations/${pickupId}`, {
      headers: admin(),
      data: { name: `FUP12 renamed ${uniq}`, address: 'Nová adresa 2' },
    })
    expect(ok.status()).toBe(200)
    const row = (await (await ctx.get('/api/pickup-locations/all', { headers: admin() })).json())
      .find((l) => l.id === pickupId)
    expect(row.name).toBe(`FUP12 renamed ${uniq}`)
    expect(row.address, 'a real address still overwrites').toBe('Nová adresa 2')

    // …and an explicit null still clears it.
    await ctx.patch(`/api/pickup-locations/${pickupId}`, { headers: admin(), data: { address: null } })
    const cleared = (await (await ctx.get('/api/pickup-locations/all', { headers: admin() })).json())
      .find((l) => l.id === pickupId)
    expect(cleared.address, 'null still clears').toBeNull()
  })
})

// ── 7. /api/roasteries — admin ──────────────────────────────────────────────
test.describe('FUP-T12 — roasteries with a non-string name', () => {
  test('POST and PATCH both answer 400', async () => {
    for (const name of MALFORMED) {
      const created = await ctx.post('/api/roasteries', { headers: admin(), data: { name } })
      expect(created.status(), `POST ${label(name)} is a client mistake`).toBe(400)
      expect((await created.json()).error).toBe(ROASTERY_NAME_REQUIRED)

      const patched = await ctx.patch(`/api/roasteries/${roasteryId}`, { headers: admin(), data: { name } })
      expect(patched.status(), `PATCH ${label(name)} is a client mistake`).toBe(400)
      expect((await patched.json()).error).toBe(ROASTERY_NAME_REQUIRED)
    }
  })

  test('NOTHING LOOSENED: a blank name still 400s, a real rename still works, and the UNIQUE 409 survives', async () => {
    const blank = await ctx.post('/api/roasteries', { headers: admin(), data: { name: '   ' } })
    expect(blank.status()).toBe(400)
    expect((await blank.json()).error).toBe(ROASTERY_NAME_REQUIRED)

    const renamed = `FUP12 roastery renamed ${uniq}`
    const ok = await ctx.patch(`/api/roasteries/${roasteryId}`, { headers: admin(), data: { name: renamed } })
    expect(ok.status(), 'a well-formed rename still works').toBe(200)
    expect((await ok.json()).name).toBe(renamed)

    // The duplicate-name branch must still be reachable — it lives past the guard.
    const dup = await ctx.post('/api/roasteries', { headers: admin(), data: { name: renamed } })
    expect(dup.status(), 'the UNIQUE 409 is still reachable').toBe(409)
  })
})

// ── 8. /api/transactions — admin ────────────────────────────────────────────
test.describe('FUP-T12 — transactions with a non-string note', () => {
  test('POST /adjustment (note is REQUIRED there) answers 400', async () => {
    for (const note of MALFORMED) {
      const res = await ctx.post('/api/transactions/adjustment', {
        headers: admin(),
        data: { friend_id: authFriend.id, amount: 1, note },
      })
      expect(res.status(), `${label(note)} is a client mistake`).toBe(400)
      expect((await res.json()).error).toBe(TX_NOTE_REQUIRED)
    }
  })

  test('POST /payment (note is OPTIONAL there) records the payment with no note', async () => {
    for (const note of MALFORMED) {
      const res = await ctx.post('/api/transactions/payment', {
        headers: admin(),
        data: { friend_id: authFriend.id, amount: 1, note },
      })
      expect(res.status(), `${label(note)} is not a server fault`).toBe(201)
      expect((await res.json()).transaction.note, 'a malformed note is stored as none').toBeNull()
    }
  })

  test('PATCH /:id with only a non-string note changes nothing', async () => {
    // ⚠ The stored note must survive: this route UPDATEs in place, so coercing the
    // malformed value to NULL would erase an admin's reason-for-adjustment.
    for (const note of MALFORMED) {
      const res = await ctx.patch(`/api/transactions/${transactionId}`, { headers: admin(), data: { note } })
      expect(res.status(), `${label(note)} is a client mistake`).toBe(400)
      expect((await res.json()).error, 'nothing left to update, the route\'s own message')
        .toBe(TX_NOTHING_TO_UPDATE)
    }

    const list = await ctx.get(`/api/transactions/friend/${authFriend.id}`, { headers: bearer() })
    const row = (await list.json()).find((t) => t.id === transactionId)
    expect(row.note, 'the original note is untouched').toBe('FUP12 pôvodná poznámka')
  })

  test('NOTHING LOOSENED: blank/absent notes and real ones still behave exactly as today', async () => {
    const blank = await ctx.post('/api/transactions/adjustment', {
      headers: admin(),
      data: { friend_id: authFriend.id, amount: 1, note: '   ' },
    })
    expect(blank.status()).toBe(400)
    expect((await blank.json()).error).toBe(TX_NOTE_REQUIRED)

    const noNote = await ctx.post('/api/transactions/payment', {
      headers: admin(),
      data: { friend_id: authFriend.id, amount: 1 },
    })
    expect(noNote.status(), 'an absent optional note is still fine').toBe(201)
    expect((await noNote.json()).transaction.note).toBeNull()

    const emptyNote = await ctx.post('/api/transactions/payment', {
      headers: admin(),
      data: { friend_id: authFriend.id, amount: 1, note: '' },
    })
    expect(emptyNote.status()).toBe(201)
    expect((await emptyNote.json()).transaction.note, "'' is still stored as NULL").toBeNull()

    const withNote = await ctx.post('/api/transactions/payment', {
      headers: admin(),
      data: { friend_id: authFriend.id, amount: 1, note: 'FUP12 real note' },
    })
    expect(withNote.status()).toBe(201)
    expect((await withNote.json()).transaction.note).toBe('FUP12 real note')

    const updated = await ctx.patch(`/api/transactions/${transactionId}`, {
      headers: admin(),
      data: { note: 'FUP12 upravená poznámka' },
    })
    expect(updated.status(), 'a real note still updates').toBe(200)
    const row = (await (await ctx.get(`/api/transactions/friend/${authFriend.id}`, { headers: bearer() })).json())
      .find((t) => t.id === transactionId)
    expect(row.note).toBe('FUP12 upravená poznámka')
  })
})

// ── 9. Google Sheets import — admin, the "already a 400" site ────────────────
//
// ⚠ THE ONLY SITE WHERE THE STATUS WAS ALREADY RIGHT, AND IT IS STILL A DEFECT.
// The route's own try/catch turned `url.match is not a function` into a 400 — but it
// ECHOED THAT SENTENCE TO THE CLIENT and still wrote ~1.2 KB of stack to the log per
// request. A status assertion alone would have called this site clean.
test.describe('FUP-T12 — Google Sheets import with a non-string url', () => {
  for (const path of ['import-gsheet', 'import-gsheet-multirow']) {
    test(`POST /api/products/${path}/:cycleId refuses without echoing internals`, async () => {
      for (const url of MALFORMED) {
        const res = await ctx.post(`/api/products/${path}/${importCycleId}`, {
          headers: admin(),
          data: { url },
        })
        expect(res.status(), `${label(url)} is a client mistake`).toBe(400)
        const body = await res.json()
        expect(body.error, "the route's own message, not the TypeError").toBe(IMPORT_URL_REQUIRED)
        expectNoInternals(body)
      }
    })
  }

  test('NOTHING LOOSENED: an absent url still 400s and a string url still reaches the parser', async () => {
    for (const path of ['import-gsheet', 'import-gsheet-multirow']) {
      const absent = await ctx.post(`/api/products/${path}/${importCycleId}`, { headers: admin(), data: {} })
      expect(absent.status()).toBe(400)
      expect((await absent.json()).error).toBe(IMPORT_URL_REQUIRED)

      // A STRING that is not a Sheets URL must still get past the guard and be
      // rejected by the URL parser — the different message proves the guard did not
      // swallow well-formed input. (No network is reached: the regex fails first.)
      const notASheet = await ctx.post(`/api/products/${path}/${importCycleId}`, {
        headers: admin(),
        data: { url: 'https://example.test/not-a-sheet' },
      })
      expect(notASheet.status()).toBe(400)
      expect((await notASheet.json()).error, 'a string url still reaches the parser')
        .toBe(IMPORT_URL_INVALID)
    }
  })
})

// ── The log half — the reason this row is worth more than a status correction ──
//
// Reading the server's stdout needs the backend's log path, exactly as the DB_PATH
// specs need the database: `SERVER_LOG=<path>`. A normal run reports these as
// skipped. The pattern (and `appended()`) is `image-upload.spec.js`'s FUP-T7 block.
const SERVER_LOG = process.env.SERVER_LOG
const STACK_FRAME = /^\s+at\s/m

test.describe('FUP-T12 — no stack reaches the log for the PUBLIC routes', () => {
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

  test('an UNAUTHENTICATED friend-login flood costs no stack at all', async () => {
    const log = await appended(async () => {
      for (const username of MALFORMED) {
        const res = await ctx.post('/api/friends/auth', { data: { username, password: 'x' } })
        expect(res.status(), `${label(username)} is refused cleanly`).toBe(401)
      }
    })
    expect(log, 'no stack frames on a client-triggerable branch').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from the TypeError').not.toMatch(/is not a function|TypeError/i)
  })

  test('the PUBLIC registration form costs no stack either, on any of its four fields', async () => {
    const log = await appended(async () => {
      for (const field of ['name', 'phone', 'email', 'username']) {
        const res = await ctx.post(`/api/onboarding/${linkToken}`, {
          data: {
            name: `FUP12 log ${uniq}`,
            phone: uniquePhone(),
            username: uniqueUsername('fup12log'),
            password: 'onboardPass1',
            [field]: { trim: 1 },
          },
        })
        expect(res.status(), `${field} is refused cleanly`).toBe(400)
      }
    })
    expect(log, 'no stack frames on a client-triggerable branch').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from the TypeError').not.toMatch(/is not a function|TypeError/i)
  })

  // ⚠ THE CHEAPEST FLOOD OF ALL, so it gets its own window. `GET
  // /onboarding/:token/check-username` is public AND carries NO rate limiter (bare
  // mount), where the two floods above are at least bucketed by `authLimiter` /
  // `abuseLimiter`. Pre-fix this appended 1156 bytes per plain GET.
  test('the UN-RATE-LIMITED public username check costs no stack at all', async () => {
    const log = await appended(async () => {
      for (const query of ['u[toString]=1', 'u[toLowerCase]=1', 'u[length]=12', 'u[]=a&u[]=b']) {
        const res = await ctx.get(`/api/onboarding/${linkToken}/check-username?${query}`)
        expect(res.status(), `?${query} is refused cleanly`).toBe(200)
      }
    })
    expect(log, 'no stack frames on a client-triggerable branch').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from the TypeError').not.toMatch(/is not a function|TypeError/i)
  })

  // The admin link PATCH — `String({toString:1})` threw a DIFFERENT TypeError
  // ("Cannot convert object to primitive value"), so it is asserted by name.
  test('the link-note PATCH costs no stack either', async () => {
    const log = await appended(async () => {
      for (const note of [{ toString: 1 }, {}, ['a', 'b'], 12345]) {
        const res = await ctx.patch(`/api/onboarding-links/${patchLinkId}`, {
          headers: admin(),
          data: { note },
        })
        expect(res.status(), `${label(note)} is refused cleanly`).toBe(400)
      }
    })
    expect(log, 'no stack frames').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from ToPrimitive').not.toMatch(/convert object to primitive|TypeError/i)
  })

  // ⚠ Counter-assertion, and it is what makes the four tests above non-vacuous.
  // Without it the whole block would be satisfied by a server that logs nothing at
  // all, or by an `appended()` window that reads the wrong file — both of which
  // would trade a log-flood for blindness to real faults.
  test('a genuine server fault still logs its full stack', async () => {
    const log = await appended(async () => {
      // A disallowed Origin is rejected with a bare Error and no status — the 500
      // branch, reachable without touching any of the routes under test.
      const res = await ctx.get('/api/cycles', {
        headers: { Origin: 'http://not-an-allowed-origin.example' },
      })
      expect(res.status()).toBe(500)
    })
    expect(log, 'the 500 branch keeps its stack').toMatch(STACK_FRAME)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// FUP-T13 — the THIRD class: a body/query field that reaches a SQLite BIND.
//
// ⚠ FUP-T12 CORRECTLY LEFT THESE ALONE. Nothing below calls a method on the value,
// so no `typeof … === 'string'` sweep for `.trim()`/`.toLowerCase()` could see them.
// The throw comes from better-sqlite3's binder and has three separate shapes, each
// measured against a running server before a line was changed:
//     `{}`            → RangeError: Too few parameter values were provided
//     `['a','b','c']` → RangeError: Too many parameter values were provided
//     `true`          → TypeError: SQLite3 can only bind numbers, strings, …
//     `{toString:1}`  → TypeError: Cannot convert object to primitive value
//                       (only where the value first passes through parseInt/parseFloat)
// Every one is a 500 plus ~1.1 KB of stack in the server log for a malformed body.
//
// ⚠ THE ROW'S TABLE NAMED SIX SITES. THE SWEEP FOUND THE WHOLE HANDLER SURFACE:
// on these five files essentially EVERY field that reaches a bind is live, because
// the repo destructures the body and binds the bindings straight into the statement.
// So the fix is not six guards — it is `bindValue()` applied where each body field
// is read, and the blocks below assert the whole matrix rather than the six.
//
// ⚠ THE SHAPE MATRIX NEEDS A ONE-ELEMENT ARRAY FOR THE OPPOSITE REASON TO FUP-T11.
// There `['x'].length === 1` made a length rule refuse BY ACCIDENT, so a suite
// carrying only that shape passed vacuously. Here better-sqlite3 SPREADS an array
// argument into the positional slots, so a one-element array happens to supply
// exactly the arity a six-slot statement wants: `{"name":["abc"]}` was ACCEPTED and
// stored the bare string `abc`. It is the one shape that was a silent SUCCESS, and
// closing the class necessarily changes it — so it is asserted separately and the
// change is recorded rather than hidden inside the crash matrix.
//
// ⚠ THE ASSERTION IS THE STORED VALUE, NOT THE STATUS. On every PATCH here the
// coercing "fix" (map the unbindable value to NULL) answers a clean 200 while
// ERASING a cycle's name, a product's stock limit or the friends password. That is
// FUP-T12's rule and it is invisible to a status check, so each PATCH block reads
// the row back.

// Messages copied verbatim from the handlers — a new string here would be a silent
// copy change on an admin screen.
const CYCLE_NAME_REQUIRED = 'Nazov je povinny'
const CYCLE_STATUS_INVALID = 'Neplatny status'
const CYCLE_FRIEND_NOT_FOUND = 'Priateľ nebol nájdený alebo je neaktívny'
const CYCLE_WRONG_PASSWORD = 'Nesprávne heslo'
const PRODUCT_FIELDS_REQUIRED = 'cycle_id a nazov su povinne'
const BAKERY_NAME_REQUIRED = 'Nazov je povinny'
const BAKERY_PRICE_REQUIRED = 'Cena je povinná (aspoň jeden variant)'

// The shapes that CRASH the binder. `['abc']` is deliberately NOT here — it is a
// silent success and has its own test.
const UNBINDABLE = [{}, { toString: 1 }, { length: 2 }, ['a', 'b', 'c'], true]

// T13 fixtures. A top-level beforeAll is collected with the file, so it runs before
// the first test regardless of where it is declared.
let t13Cycle // a cycle with every optional column populated — the PATCH read-back target
let t13Product // likewise for products (incl. a real stock_limit_g)
let t13Bakery // a bakery product with one real variant
let t13AuthCycle // a cycle with a shared_password, for POST /cycles/:id/auth
let t13Friend // an active friend id
let t13StockCycle // a cycle carrying a stock-limited product, for the availability route

const T13_SHARED = 't13SharedPass'

test.beforeAll(async () => {
  const cycle = await ctx.post('/api/cycles', {
    headers: admin(),
    data: { name: `FUP13 cycle ${uniq}`, expected_date: '2026-12-24', plan_note: 'FUP13 pôvodná poznámka' },
  })
  expect(cycle.status(), 'T13 cycle fixture').toBe(201)
  t13Cycle = (await cycle.json()).id
  const seeded = await ctx.patch(`/api/cycles/${t13Cycle}`, {
    headers: admin(),
    data: { shared_password: 'fup13cyclePass', markup_ratio: 1.25, parcel_fee: 3.5 },
  })
  expect(seeded.status(), 'T13 cycle seeded with every optional column').toBe(200)

  const product = await ctx.post('/api/products', {
    headers: admin(),
    data: {
      cycle_id: t13Cycle,
      name: `FUP13 product ${uniq}`,
      description1: 'FUP13 popis',
      roast_type: 'Svetlé',
      purpose: 'Filter',
      price_250g: 11.5,
      roastery: 'FUP13 pražiareň',
      stock_limit_g: 4000,
    },
  })
  expect(product.status(), 'T13 product fixture').toBe(201)
  t13Product = (await product.json()).id

  const bakery = await ctx.post('/api/bakery-products', {
    headers: admin(),
    data: {
      name: `FUP13 bakery ${uniq}`,
      description: 'FUP13 bakery popis',
      subtitle: 'FUP13 podtitul',
      composition: 'FUP13 zloženie',
      category: 'sladké',
      variants: [{ label: '1ks', weight_grams: 500, price: 4.5 }],
    },
  })
  expect(bakery.status(), 'T13 bakery fixture').toBe(201)
  t13Bakery = (await bakery.json()).id

  const authCycle = await ctx.post('/api/cycles', {
    headers: admin(),
    data: { name: `FUP13 auth ${uniq}` },
  })
  expect(authCycle.status(), 'T13 auth cycle fixture').toBe(201)
  t13AuthCycle = (await authCycle.json()).id
  await ctx.patch(`/api/cycles/${t13AuthCycle}`, {
    headers: admin(),
    data: { shared_password: T13_SHARED },
  })
  t13Friend = await createFriend('t13')

  const stockCycle = await ctx.post('/api/cycles', {
    headers: admin(),
    data: { name: `FUP13 stock ${uniq}` },
  })
  expect(stockCycle.status(), 'T13 stock cycle fixture').toBe(201)
  t13StockCycle = (await stockCycle.json()).id
  const limited = await ctx.post('/api/products', {
    headers: admin(),
    data: { cycle_id: t13StockCycle, name: `FUP13 limited ${uniq}`, price_250g: 9, stock_limit_g: 2000 },
  })
  expect(limited.status(), 'T13 stock-limited product fixture').toBe(201)
})

const cycleRow = async (id) => (await ctx.get(`/api/cycles/${id}`, { headers: admin() })).json()
const productRow = async (id) => (await ctx.get(`/api/products/${id}`)).json()
// ⚠ `/api/bakery-products` is mounted BEHIND `requireAdmin` (index.js:97) with no
// inline guard on the route, so an unauthenticated GET here answers 401 — and a
// read-back that then compared `undefined` to `undefined` would pass VACUOUSLY. The
// blocks below therefore also assert the seeded values are really present first.
const bakeryRow = async (id) => (await ctx.get(`/api/bakery-products/${id}`, { headers: admin() })).json()
const settingsRow = async () => (await ctx.get('/api/admin/settings', { headers: admin() })).json()

// ── T13.1 GET /api/products/cycle/:id/availability — ⚠ PUBLIC, NO RATE LIMITER ──
//
// The sharpest site in this row and the only one that is neither admin- nor
// friend-guarded. `?excludeFriendId[a]=1` is a plain GET with no body, no
// credential and no bucket, and it appended 1120 bytes of stack PER REQUEST — a
// cheaper flood than the one FUP-T12 was opened for, on an endpoint every friend's
// order screen already polls.
test.describe('FUP-T13 — public availability with a non-string ?excludeFriendId', () => {
  for (const query of ['excludeFriendId[a]=1', 'excludeFriendId=1&excludeFriendId=2', 'excludeFriendId[toString]=1']) {
    test(`?${query} is a 200, never a 500`, async () => {
      const res = await ctx.get(`/api/products/cycle/${t13StockCycle}/availability?${query}`)
      expect(res.status(), `?${query} must not be a server fault`).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body), 'the ordinary availability payload').toBe(true)
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: absent and real ?excludeFriendId still answer as today', async () => {
    const absent = await ctx.get(`/api/products/cycle/${t13StockCycle}/availability`)
    expect(absent.status()).toBe(200)
    const rows = await absent.json()
    expect(rows.length, 'the stock-limited product is listed').toBeGreaterThan(0)
    expect(rows[0].stock_limit_g).toBe(2000)

    // A real friend id still reaches the exclusion branch — the malformed shapes
    // must land on "no exclusion", not on "the query was dropped entirely".
    const real = await ctx.get(`/api/products/cycle/${t13StockCycle}/availability?excludeFriendId=${t13Friend}`)
    expect(real.status()).toBe(200)
    expect((await real.json())[0].stock_limit_g).toBe(2000)
  })
})

// ── T13.2 POST /api/cycles/:id/auth — public behind the cycle's shared password ──
test.describe('FUP-T13 — cycle auth with a non-string friendId', () => {
  for (const friendId of UNBINDABLE) {
    test(`friendId ${label(friendId)} is a 404, never a 500`, async () => {
      const res = await ctx.post(`/api/cycles/${t13AuthCycle}/auth`, {
        data: { password: T13_SHARED, friendId },
      })
      expect(res.status(), `${label(friendId)} is refused as an unknown friend`).toBe(404)
      const body = await res.json()
      expect(body.error, "the route's existing message").toBe(CYCLE_FRIEND_NOT_FOUND)
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: a real friendId still authenticates and a wrong password still 401s', async () => {
    const ok = await ctx.post(`/api/cycles/${t13AuthCycle}/auth`, {
      data: { password: T13_SHARED, friendId: t13Friend },
    })
    expect(ok.status(), 'the real pair still authenticates').toBe(200)
    expect((await ok.json()).friend.id).toBe(t13Friend)

    const wrong = await ctx.post(`/api/cycles/${t13AuthCycle}/auth`, {
      data: { password: 'not-the-password', friendId: t13Friend },
    })
    expect(wrong.status()).toBe(401)
    expect((await wrong.json()).error).toBe(CYCLE_WRONG_PASSWORD)

    // ⚠ The password check must still run BEFORE the friend lookup: a malformed
    // friendId with a WRONG password must answer 401, not 404, or the refusal
    // becomes a friend-existence oracle for anyone who does not know the password.
    const both = await ctx.post(`/api/cycles/${t13AuthCycle}/auth`, {
      data: { password: 'not-the-password', friendId: {} },
    })
    expect(both.status(), 'ordering preserved: password first').toBe(401)
  })
})

// ── T13.3 POST /api/cycles ────────────────────────────────────────────────────
test.describe('FUP-T13 — POST /api/cycles with a non-string field', () => {
  for (const name of UNBINDABLE) {
    test(`name ${label(name)} is a 400 with the route's own message`, async () => {
      const res = await ctx.post('/api/cycles', { headers: admin(), data: { name } })
      expect(res.status()).toBe(400)
      const body = await res.json()
      expect(body.error).toBe(CYCLE_NAME_REQUIRED)
      expectNoInternals(body)
    })
  }

  test('the OPTIONAL columns are treated as absent, not as a 500', async () => {
    for (const field of ['expected_date', 'type', 'plan_note']) {
      for (const bad of UNBINDABLE) {
        const res = await ctx.post('/api/cycles', {
          headers: admin(),
          data: { name: `FUP13 opt ${field} ${uniq}${nextSeq()}`, [field]: bad },
        })
        expect(res.status(), `${field}=${label(bad)} still creates the cycle`).toBe(201)
        const row = await res.json()
        if (field === 'type') expect(row.type, 'the default type, exactly as if absent').toBe('coffee')
        else expect(row[field], `${field} stored as absent`).toBeNull()
      }
    }
  })

  test('a non-object element in bakery_product_ids snapshots nothing instead of 500-ing', async () => {
    for (const ids of [[{}], [true], [{ toString: 1 }]]) {
      const res = await ctx.post('/api/cycles', {
        headers: admin(),
        data: { name: `FUP13 bpid ${uniq}${nextSeq()}`, type: 'bakery', bakery_product_ids: ids },
      })
      expect(res.status(), `${label(ids)} must not be a server fault`).toBe(201)
      const created = await res.json()
      const products = await ctx.get(`/api/products/cycle/${created.id}`)
      expect((await products.json()).length, 'nothing snapshotted from a junk id').toBe(0)
    }
  })

  test('NOTHING LOOSENED: an empty name still 400s and a full create still works', async () => {
    for (const name of ['', undefined, null]) {
      const res = await ctx.post('/api/cycles', { headers: admin(), data: { name } })
      expect(res.status(), `${label(name)} still 400s`).toBe(400)
      expect((await res.json()).error).toBe(CYCLE_NAME_REQUIRED)
    }

    const good = await ctx.post('/api/cycles', {
      headers: admin(),
      data: {
        name: `FUP13 good ${uniq}`,
        expected_date: '2026-11-11',
        plan_note: 'FUP13 plán',
        type: 'coffee',
        status: 'planned',
      },
    })
    expect(good.status()).toBe(201)
    const row = await good.json()
    expect(row.name).toBe(`FUP13 good ${uniq}`)
    expect(row.expected_date).toBe('2026-11-11')
    expect(row.plan_note).toBe('FUP13 plán')
    expect(row.status).toBe('planned')

    // A real bakery snapshot still happens — the junk-element test above must not be
    // satisfied by a route that stopped snapshotting altogether.
    const bakeryCycle = await ctx.post('/api/cycles', {
      headers: admin(),
      data: { name: `FUP13 bakery cycle ${uniq}`, type: 'bakery', bakery_product_ids: [t13Bakery] },
    })
    expect(bakeryCycle.status()).toBe(201)
    const snapshot = await ctx.get(`/api/products/cycle/${(await bakeryCycle.json()).id}`)
    expect((await snapshot.json()).length, 'a REAL bakery id still snapshots').toBeGreaterThan(0)
  })
})

// ── T13.4 PATCH /api/cycles/:id — the read-back block ─────────────────────────
test.describe('FUP-T13 — PATCH /api/cycles/:id leaves every column UNCHANGED', () => {
  test('a non-string value never writes and never wipes', async () => {
    const before = await cycleRow(t13Cycle)
    expect(before.name, 'the fixture row really loaded').toContain('FUP13 cycle')
    expect(before.shared_password).toBe('fup13cyclePass')
    expect(before.markup_ratio).toBe(1.25)
    expect(before.parcel_fee).toBe(3.5)
    expect(before.expected_date).toBe('2026-12-24')
    expect(before.plan_note).toBe('FUP13 pôvodná poznámka')
    for (const field of ['name', 'shared_password', 'markup_ratio', 'expected_date', 'plan_note', 'parcel_fee']) {
      for (const bad of UNBINDABLE) {
        const res = await ctx.patch(`/api/cycles/${t13Cycle}`, { headers: admin(), data: { [field]: bad } })
        expect(res.status(), `${field}=${label(bad)} must not be a server fault`).toBe(200)
        const after = await cycleRow(t13Cycle)
        expect(after[field], `${field} survives ${label(bad)}`).toBe(before[field])
      }
    }
    // Nothing else drifted either.
    expect(await cycleRow(t13Cycle)).toEqual(before)
  })

  test('NOTHING LOOSENED: an explicit null still CLEARS and a real value still writes', async () => {
    const rename = await ctx.patch(`/api/cycles/${t13Cycle}`, {
      headers: admin(),
      data: { name: `FUP13 renamed ${uniq}`, markup_ratio: 1.4, parcel_fee: 2.25 },
    })
    expect(rename.status()).toBe(200)
    let row = await cycleRow(t13Cycle)
    expect(row.name).toBe(`FUP13 renamed ${uniq}`)
    expect(row.markup_ratio).toBe(1.4)
    expect(row.parcel_fee).toBe(2.25)

    // ⚠ The `undefined`-means-absent rule must not swallow an EXPLICIT null: these
    // three columns are cleared from the admin UI by sending null.
    const cleared = await ctx.patch(`/api/cycles/${t13Cycle}`, {
      headers: admin(),
      data: { shared_password: null, expected_date: null, plan_note: null },
    })
    expect(cleared.status()).toBe(200)
    row = await cycleRow(t13Cycle)
    expect(row.shared_password, 'explicit null still clears').toBeNull()
    expect(row.expected_date, 'explicit null still clears').toBeNull()
    expect(row.plan_note, 'explicit null still clears').toBeNull()

    // The enum guard on `status` is untouched.
    const badStatus = await ctx.patch(`/api/cycles/${t13Cycle}`, { headers: admin(), data: { status: 'nonsense' } })
    expect(badStatus.status()).toBe(400)
    expect((await badStatus.json()).error).toBe(CYCLE_STATUS_INVALID)
  })
})

// ── T13.5 GET /api/cycles/:id/summary?roastery ────────────────────────────────
test.describe('FUP-T13 — the summary sheet with a non-string ?roastery', () => {
  test('a malformed filter is the unfiltered sheet, never a 500', async () => {
    for (const query of ['roastery[a]=1', 'roastery=a&roastery=b', 'roastery[toString]=1']) {
      const res = await ctx.get(`/api/cycles/${t13Cycle}/summary?${query}`, { headers: admin() })
      expect(res.status(), `?${query} must not be a server fault`).toBe(200)
      expectNoInternals(await res.json())
    }
  })

  test('NOTHING LOOSENED: _default and a real roastery name still filter', async () => {
    const all = await ctx.get(`/api/cycles/${t13Cycle}/summary`, { headers: admin() })
    expect(all.status()).toBe(200)
    // ⚠ `_default` is the "hlavná pražiareň" chip whose empty-string bug 500'd this
    // endpoint in production once already (GSO-T8) — it must still be a 200.
    const def = await ctx.get(`/api/cycles/${t13Cycle}/summary?roastery=_default`, { headers: admin() })
    expect(def.status()).toBe(200)
    const named = await ctx.get(`/api/cycles/${t13Cycle}/summary?roastery=FUP13%20pra%C5%BEiare%C5%88`, {
      headers: admin(),
    })
    expect(named.status()).toBe(200)
  })
})

// ── T13.6 POST /api/products ──────────────────────────────────────────────────
test.describe('FUP-T13 — POST /api/products with a non-string field', () => {
  for (const field of ['cycle_id', 'name']) {
    test(`a non-string ${field} is a 400 with the route's own message`, async () => {
      for (const bad of UNBINDABLE) {
        const res = await ctx.post('/api/products', {
          headers: admin(),
          data: { cycle_id: t13Cycle, name: `FUP13 req ${uniq}${nextSeq()}`, [field]: bad },
        })
        expect(res.status(), `${field}=${label(bad)}`).toBe(400)
        const body = await res.json()
        expect(body.error).toBe(PRODUCT_FIELDS_REQUIRED)
        expectNoInternals(body)
      }
    })
  }

  const OPTIONAL = [
    'description1', 'description2', 'roast_type', 'purpose',
    'price_150g', 'price_200g', 'price_250g', 'price_500g', 'price_1kg', 'price_20pc5g',
    'roastery', 'stock_limit_g',
  ]

  test('every OPTIONAL column stores exactly what an absent field stores', async () => {
    for (const field of OPTIONAL) {
      for (const bad of UNBINDABLE) {
        const res = await ctx.post('/api/products', {
          headers: admin(),
          data: { cycle_id: t13Cycle, name: `FUP13 opt ${uniq}${nextSeq()}`, [field]: bad },
        })
        expect(res.status(), `${field}=${label(bad)} still creates the product`).toBe(201)
        expect((await res.json())[field], `${field} stored as absent`).toBeNull()
      }
    }
  })

  test('NOTHING LOOSENED: absent required fields still 400 and a full create still works', async () => {
    const missing = await ctx.post('/api/products', { headers: admin(), data: { name: 'x' } })
    expect(missing.status()).toBe(400)
    expect((await missing.json()).error).toBe(PRODUCT_FIELDS_REQUIRED)

    const good = await ctx.post('/api/products', {
      headers: admin(),
      data: {
        cycle_id: t13Cycle,
        name: `FUP13 full ${uniq}`,
        description1: 'popis 1',
        description2: 'popis 2',
        roast_type: 'Tmavé',
        purpose: 'Espresso',
        price_250g: 12.5,
        price_1kg: 40,
        roastery: 'FUP13 pražiareň',
        stock_limit_g: 3000,
      },
    })
    expect(good.status()).toBe(201)
    const row = await good.json()
    expect(row.name).toBe(`FUP13 full ${uniq}`)
    expect(row.price_250g).toBe(12.5)
    expect(row.price_1kg).toBe(40)
    expect(row.roastery).toBe('FUP13 pražiareň')
    expect(row.stock_limit_g, 'a real stock limit still writes').toBe(3000)
    expect(row.purpose).toBe('Espresso')

    // ⚠ A NUMERIC STRING must still reach the numeric columns — the app's own admin
    // form posts these as strings, so a guard that demanded `typeof === 'number'`
    // would silently drop every price the UI sends.
    const strings = await ctx.post('/api/products', {
      headers: admin(),
      data: { cycle_id: t13Cycle, name: `FUP13 str ${uniq}`, price_250g: '13.5', stock_limit_g: '2500' },
    })
    expect(strings.status()).toBe(201)
    const s = await strings.json()
    expect(s.price_250g).toBe(13.5)
    expect(s.stock_limit_g).toBe(2500)
  })
})

// ── T13.7 PATCH /api/products/:id — the read-back block ───────────────────────
test.describe('FUP-T13 — PATCH /api/products/:id leaves every column UNCHANGED', () => {
  const PATCHABLE = [
    'name', 'description1', 'description2', 'roast_type', 'purpose',
    'price_150g', 'price_200g', 'price_250g', 'price_500g', 'price_1kg', 'price_20pc5g',
    'image', 'roastery', 'stock_limit_g',
  ]

  test('a non-string value never writes and never wipes', async () => {
    const before = await productRow(t13Product)
    // Non-vacuity: an empty/error payload would make every comparison below trivially
    // true, which is exactly how a read-back assertion dies quietly.
    expect(before.name, 'the fixture row really loaded').toContain('FUP13 product')
    expect(before.price_250g).toBe(11.5)
    expect(before.stock_limit_g).toBe(4000)
    for (const field of PATCHABLE) {
      for (const bad of UNBINDABLE) {
        const res = await ctx.patch(`/api/products/${t13Product}`, { headers: admin(), data: { [field]: bad } })
        expect(res.status(), `${field}=${label(bad)} must not be a server fault`).toBe(200)
        expect((await productRow(t13Product))[field], `${field} survives ${label(bad)}`).toBe(before[field])
      }
    }
    expect(await productRow(t13Product)).toEqual(before)
  })

  // ⚠ THE ONE THAT WAS ALREADY SILENTLY DESTRUCTIVE. `{"stock_limit_g":{}}` answered
  // 200 before this row — `{}` is truthy, `parseInt({})` is NaN, and better-sqlite3
  // binds NaN as NULL — so a malformed body REMOVED a product's stock limit and the
  // status said everything was fine. That is the exact failure mode the read-back
  // assertion exists for.
  test('a malformed stock_limit_g no longer silently REMOVES the limit', async () => {
    const before = await productRow(t13Product)
    expect(before.stock_limit_g, 'the fixture really has a limit').toBe(4000)
    for (const bad of UNBINDABLE) {
      const res = await ctx.patch(`/api/products/${t13Product}`, { headers: admin(), data: { stock_limit_g: bad } })
      expect(res.status()).toBe(200)
      expect((await productRow(t13Product)).stock_limit_g, `the limit survives ${label(bad)}`).toBe(4000)
    }
  })

  test('NOTHING LOOSENED: explicit null still clears and real values still write', async () => {
    const write = await ctx.patch(`/api/products/${t13Product}`, {
      headers: admin(),
      data: { name: `FUP13 renamed ${uniq}`, price_250g: 15.25, stock_limit_g: 6000, purpose: 'Espresso' },
    })
    expect(write.status()).toBe(200)
    let row = await productRow(t13Product)
    expect(row.name).toBe(`FUP13 renamed ${uniq}`)
    expect(row.price_250g).toBe(15.25)
    expect(row.stock_limit_g).toBe(6000)
    expect(row.purpose).toBe('Espresso')

    const cleared = await ctx.patch(`/api/products/${t13Product}`, {
      headers: admin(),
      data: { description1: null, roastery: null, price_1kg: null },
    })
    expect(cleared.status()).toBe(200)
    row = await productRow(t13Product)
    expect(row.description1, 'explicit null still clears').toBeNull()
    expect(row.roastery, 'explicit null still clears').toBeNull()
    expect(row.price_1kg, 'explicit null still clears').toBeNull()

    // `active` is booleanised (`active ? 1 : 0`), never bound raw — it must be
    // untouched by this row, including for the shapes above.
    const off = await ctx.patch(`/api/products/${t13Product}`, { headers: admin(), data: { active: 0 } })
    expect((await off.json()).active).toBe(0)
    const on = await ctx.patch(`/api/products/${t13Product}`, { headers: admin(), data: { active: 1 } })
    expect((await on.json()).active).toBe(1)

    // Restore the limit for any later reader of this fixture.
    await ctx.patch(`/api/products/${t13Product}`, { headers: admin(), data: { stock_limit_g: 4000 } })
  })
})

// ── T13.8 POST /api/bakery-products ───────────────────────────────────────────
test.describe('FUP-T13 — POST /api/bakery-products with a non-string field', () => {
  test('a non-string name is a 400 with the route\'s own message', async () => {
    for (const bad of UNBINDABLE) {
      const res = await ctx.post('/api/bakery-products', { headers: admin(), data: { name: bad, price: 3 } })
      expect(res.status(), `name=${label(bad)}`).toBe(400)
      const body = await res.json()
      expect(body.error).toBe(BAKERY_NAME_REQUIRED)
      expectNoInternals(body)
    }
  })

  test('a non-string price is the route\'s existing "price is required" 400', async () => {
    for (const bad of UNBINDABLE) {
      const res = await ctx.post('/api/bakery-products', {
        headers: admin(),
        data: { name: `FUP13 bp ${uniq}${nextSeq()}`, price: bad },
      })
      expect(res.status(), `price=${label(bad)}`).toBe(400)
      const body = await res.json()
      expect(body.error).toBe(BAKERY_PRICE_REQUIRED)
      expectNoInternals(body)
    }
  })

  test('the optional columns are treated as absent, not as a 500', async () => {
    for (const field of ['description', 'subtitle', 'composition', 'weight_grams']) {
      for (const bad of UNBINDABLE) {
        const res = await ctx.post('/api/bakery-products', {
          headers: admin(),
          data: { name: `FUP13 bopt ${uniq}${nextSeq()}`, price: 3, [field]: bad },
        })
        expect(res.status(), `${field}=${label(bad)} still creates`).toBe(201)
        expect((await res.json())[field], `${field} stored as absent`).toBeNull()
      }
    }
    // `category` has a default rather than a NULL.
    for (const bad of UNBINDABLE) {
      const res = await ctx.post('/api/bakery-products', {
        headers: admin(),
        data: { name: `FUP13 bcat ${uniq}${nextSeq()}`, price: 3, category: bad },
      })
      expect(res.status()).toBe(201)
      expect((await res.json()).category, 'the default category, exactly as if absent').toBe('slané')
    }
  })

  test('a junk variants ELEMENT is not a 500 — including [null], which was a TypeError', async () => {
    for (const variants of [[null], [1], ['a', 'b'], [{ price: {} }], [{ label: {}, price: 2 }], [{ weight_grams: { toString: 1 }, price: 2 }]]) {
      const res = await ctx.post('/api/bakery-products', {
        headers: admin(),
        data: { name: `FUP13 bvar ${uniq}${nextSeq()}`, variants },
      })
      expect(res.status(), `variants=${label(variants)} must not be a server fault`).toBeLessThan(500)
      expectNoInternals(await res.json())
    }
  })

  test('NOTHING LOOSENED: absent name/price still 400 and a real create still works', async () => {
    const noName = await ctx.post('/api/bakery-products', { headers: admin(), data: { price: 3 } })
    expect(noName.status()).toBe(400)
    expect((await noName.json()).error).toBe(BAKERY_NAME_REQUIRED)

    const noPrice = await ctx.post('/api/bakery-products', {
      headers: admin(),
      data: { name: `FUP13 nop ${uniq}` },
    })
    expect(noPrice.status()).toBe(400)
    expect((await noPrice.json()).error).toBe(BAKERY_PRICE_REQUIRED)

    const good = await ctx.post('/api/bakery-products', {
      headers: admin(),
      data: {
        name: `FUP13 bgood ${uniq}`,
        description: 'popis',
        subtitle: 'podtitul',
        composition: 'zloženie',
        category: 'sladké',
        variants: [
          { label: '1ks', weight_grams: 500, price: 5.5 },
          { label: '1/2', weight_grams: '250', price: '2.75' },
        ],
      },
    })
    expect(good.status()).toBe(201)
    const row = await good.json()
    expect(row.name).toBe(`FUP13 bgood ${uniq}`)
    expect(row.category).toBe('sladké')
    expect(row.variants.length).toBe(2)
    expect(row.variants[0].price).toBe(5.5)
    expect(row.variants[0].weight_grams).toBe(500)
    // Numeric STRINGS still reach the numeric columns (the admin form posts them).
    expect(row.variants[1].price).toBe(2.75)
    expect(row.variants[1].weight_grams).toBe(250)

    // The top-level backward-compat path (no variants array) still works.
    const compat = await ctx.post('/api/bakery-products', {
      headers: admin(),
      data: { name: `FUP13 bcompat ${uniq}`, price: '4.25', weight_grams: '300' },
    })
    expect(compat.status()).toBe(201)
    const c = await compat.json()
    expect(c.price).toBe(4.25)
    expect(c.weight_grams).toBe(300)
    expect(c.variants[0].price).toBe(4.25)
  })
})

// ── T13.9 PATCH /api/bakery-products/:id — the read-back block ────────────────
test.describe('FUP-T13 — PATCH /api/bakery-products/:id leaves every column UNCHANGED', () => {
  test('a non-string value never writes and never wipes', async () => {
    const before = await bakeryRow(t13Bakery)
    // Non-vacuity: the fixture really carries the values this test claims survive.
    expect(before.name, 'the fixture row really loaded').toContain('FUP13 bakery')
    expect(before.description).toBe('FUP13 bakery popis')
    expect(before.category).toBe('sladké')
    for (const field of ['name', 'description', 'subtitle', 'composition', 'category', 'image']) {
      for (const bad of UNBINDABLE) {
        const res = await ctx.patch(`/api/bakery-products/${t13Bakery}`, {
          headers: admin(),
          data: { [field]: bad },
        })
        expect(res.status(), `${field}=${label(bad)} must not be a server fault`).toBe(200)
        expect((await bakeryRow(t13Bakery))[field], `${field} survives ${label(bad)}`).toBe(before[field])
      }
    }
  })

  test('a junk variants ELEMENT never 500s and never destroys the real variant', async () => {
    const before = await bakeryRow(t13Bakery)
    expect(before.variants.length, 'the fixture really has a variant').toBe(1)
    for (const variants of [[null], [1], [{ id: {}, label: 'x', price: 2 }], [{ price: { toString: 1 } }]]) {
      const res = await ctx.patch(`/api/bakery-products/${t13Bakery}`, {
        headers: admin(),
        data: { variants },
      })
      expect(res.status(), `variants=${label(variants)} must not be a server fault`).toBeLessThan(500)
      expectNoInternals(await res.json())
    }
    // Restore a known-good variant set for the counter-assertion below.
    const restore = await ctx.patch(`/api/bakery-products/${t13Bakery}`, {
      headers: admin(),
      data: { variants: [{ label: '1ks', weight_grams: 500, price: 4.5 }] },
    })
    expect(restore.status()).toBe(200)
  })

  test('NOTHING LOOSENED: real values and a real variant sync still write', async () => {
    const res = await ctx.patch(`/api/bakery-products/${t13Bakery}`, {
      headers: admin(),
      data: {
        name: `FUP13 brenamed ${uniq}`,
        description: 'nový popis',
        category: 'slané',
        variants: [{ label: '2ks', weight_grams: 750, price: 6.5 }],
      },
    })
    expect(res.status()).toBe(200)
    const row = await res.json()
    expect(row.name).toBe(`FUP13 brenamed ${uniq}`)
    expect(row.description).toBe('nový popis')
    expect(row.category).toBe('slané')
    expect(row.variants.length).toBe(1)
    expect(row.variants[0].label).toBe('2ks')
    expect(row.variants[0].price).toBe(6.5)
    expect(row.variants[0].weight_grams).toBe(750)

    // An existing variant is still UPDATED in place (id path), not re-created.
    const existingId = row.variants[0].id
    const again = await ctx.patch(`/api/bakery-products/${t13Bakery}`, {
      headers: admin(),
      data: { variants: [{ id: existingId, label: '2ks', weight_grams: 750, price: 7 }] },
    })
    const updated = await again.json()
    expect(updated.variants[0].id, 'updated in place').toBe(existingId)
    expect(updated.variants[0].price).toBe(7)

    const cleared = await ctx.patch(`/api/bakery-products/${t13Bakery}`, {
      headers: admin(),
      data: { description: null, subtitle: null },
    })
    expect(cleared.status()).toBe(200)
    const c = await cleared.json()
    expect(c.description, 'explicit null still clears').toBeNull()
    expect(c.subtitle, 'explicit null still clears').toBeNull()
  })
})

// ── T13.10 PUT /api/admin/settings ────────────────────────────────────────────
//
// ⚠ THE MOST DANGEROUS COERCION IN THE ROW. `friendsPassword` is a live credential:
// mapping an unbindable value to `''` would answer 200 and BLANK THE FRIENDS
// PASSWORD for the whole instance. So the assertion here is the value read back,
// and "absent" must mean no write at all.
test.describe('FUP-T13 — PUT /api/admin/settings leaves every setting UNCHANGED', () => {
  test('a non-string setting never writes and never blanks a credential', async () => {
    const before = await settingsRow()
    expect(before.friendsPassword, 'the fixture really has a friends password').toBeTruthy()
    for (const field of ['friendsPassword', 'paymentIban', 'paymentRevolutUsername']) {
      for (const bad of UNBINDABLE) {
        const res = await ctx.put('/api/admin/settings', { headers: admin(), data: { [field]: bad } })
        expect(res.status(), `${field}=${label(bad)} must not be a server fault`).toBe(200)
        const after = await settingsRow()
        expect(after[field], `${field} survives ${label(bad)}`).toBe(before[field])
      }
    }
    expect(await settingsRow(), 'no setting drifted').toEqual(before)

    // The shared friends password really still authenticates — a blanked credential
    // would otherwise be invisible to a read-back that compared '' to ''.
    const auth = await ctx.post('/api/friends/auth', { data: { password: FRIENDS_PASSWORD } })
    expect(auth.status(), 'the friends password still works').toBe(200)
  })

  test('NOTHING LOOSENED: real values still write and an empty string still clears', async () => {
    const before = await settingsRow()
    const write = await ctx.put('/api/admin/settings', {
      headers: admin(),
      data: { paymentIban: 'SK9911000000002611000000', paymentRevolutUsername: 'fup13user' },
    })
    expect(write.status()).toBe(200)
    let row = await settingsRow()
    expect(row.paymentIban).toBe('SK9911000000002611000000')
    expect(row.paymentRevolutUsername).toBe('fup13user')

    const cleared = await ctx.put('/api/admin/settings', {
      headers: admin(),
      data: { paymentIban: '', paymentRevolutUsername: '' },
    })
    expect(cleared.status()).toBe(200)
    row = await settingsRow()
    expect(row.paymentIban, 'an empty string still clears').toBe('')
    expect(row.paymentRevolutUsername, 'an empty string still clears').toBe('')

    // Restore, and prove the friends password can still be REWRITTEN to itself.
    const restore = await ctx.put('/api/admin/settings', {
      headers: admin(),
      data: {
        friendsPassword: FRIENDS_PASSWORD,
        paymentIban: before.paymentIban,
        paymentRevolutUsername: before.paymentRevolutUsername,
      },
    })
    expect(restore.status()).toBe(200)
    expect((await settingsRow()).friendsPassword).toBe(FRIENDS_PASSWORD)
  })
})

// ── T13.11 GET /api/analytics/rewards?limit ───────────────────────────────────
//
// ⚠ DELIBERATELY NOT A LOG-FLOOD SITE, and the comment in the code says so. This
// route has its own try/catch that logs `e.message` ONLY — 72 bytes, no stack — so
// the defect is purely the WRONG STATUS (a malformed query string is not a server
// fault). It is fixed for correctness, not hygiene, and nobody should later
// "harden" it as if it leaked a stack.
test.describe('FUP-T13 — the rewards report with a non-string ?limit', () => {
  test('a malformed ?limit falls back to the default instead of 500-ing', async () => {
    for (const query of ['limit[toString]=1', 'limit[a]=1', 'limit=1&limit=2']) {
      const res = await ctx.get(`/api/analytics/rewards?${query}`, { headers: admin() })
      expect(res.status(), `?${query} must not be a server fault`).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body.cycles), 'the ordinary report shape').toBe(true)
      expectNoInternals(body)
    }
  })

  test('NOTHING LOOSENED: absent, numeric and unparseable limits all answer as today', async () => {
    const absent = await ctx.get('/api/analytics/rewards', { headers: admin() })
    expect(absent.status()).toBe(200)
    const nonNumeric = await ctx.get('/api/analytics/rewards?limit=abc', { headers: admin() })
    expect(nonNumeric.status(), 'an unparseable STRING already fell back to the default').toBe(200)
    expect(await nonNumeric.json()).toEqual(await absent.json())

    const one = await ctx.get('/api/analytics/rewards?limit=1', { headers: admin() })
    expect(one.status()).toBe(200)
    const all = await absent.json()
    const limited = await one.json()
    expect(limited.cycles.length, 'a real limit still limits').toBeLessThanOrEqual(1)
    expect(limited.cycles.length).toBeLessThanOrEqual(all.cycles.length)
  })
})

// ── T13.12 The one-element array — the SILENT SUCCESS, recorded not hidden ────
//
// ⚠ THIS IS A DELIBERATE BEHAVIOUR CHANGE AND THE ONLY ONE IN THE ROW. better-
// sqlite3 SPREADS an array argument into a statement's positional slots, so a
// ONE-element array happened to supply exactly the arity these statements wanted:
// `{"name":["abc"]}` returned 201 and stored the bare string `abc`, with the value
// silently unwrapped from a container the caller never meant as a value. It is not
// a crash, so no shape matrix built from the crashing shapes would have found it —
// and leaving it would mean the class was only half closed, since the SAME array on
// a statement with a different arity is one of the RangeErrors above.
//
// After this row a one-element array is treated exactly like every other
// unbindable shape: the route's existing refusal, or "absent".
test.describe('FUP-T13 — a ONE-element array is no longer silently unwrapped', () => {
  test('it takes the same path as every other unbindable shape', async () => {
    const cycle = await ctx.post('/api/cycles', { headers: admin(), data: { name: ['abc'] } })
    expect(cycle.status(), 'was 201 storing "abc"').toBe(400)
    expect((await cycle.json()).error).toBe(CYCLE_NAME_REQUIRED)

    const product = await ctx.post('/api/products', {
      headers: admin(),
      data: { cycle_id: t13Cycle, name: ['abc'] },
    })
    expect(product.status(), 'was 201 storing "abc"').toBe(400)
    expect((await product.json()).error).toBe(PRODUCT_FIELDS_REQUIRED)

    const bakery = await ctx.post('/api/bakery-products', {
      headers: admin(),
      data: { name: ['abc'], price: 3 },
    })
    expect(bakery.status(), 'was 201 storing "abc"').toBe(400)
    expect((await bakery.json()).error).toBe(BAKERY_NAME_REQUIRED)

    const before = await cycleRow(t13Cycle)
    const patched = await ctx.patch(`/api/cycles/${t13Cycle}`, { headers: admin(), data: { name: ['abc'] } })
    expect(patched.status()).toBe(200)
    expect((await cycleRow(t13Cycle)).name, 'was renamed to "abc"').toBe(before.name)

    const ibanBefore = (await settingsRow()).paymentIban
    const settings = await ctx.put('/api/admin/settings', {
      headers: admin(),
      data: { paymentIban: ['SK99'] },
    })
    expect(settings.status()).toBe(200)
    expect((await settingsRow()).paymentIban, 'was stored as the bare string "SK99"').toBe(ibanBefore)
  })
})

// ── T13.13 The log half ───────────────────────────────────────────────────────
test.describe('FUP-T13 — no stack reaches the log for any site in this row', () => {
  test.skip(!SERVER_LOG, 'set SERVER_LOG=<backend log path> to exercise the log assertions')

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
    await new Promise((r) => setTimeout(r, 400))
    const fh = await fs.promises.open(SERVER_LOG, 'r')
    const size = (await fh.stat()).size
    const buf = Buffer.alloc(Math.max(0, size - before))
    if (buf.length) await fh.read(buf, 0, buf.length, before)
    await fh.close()
    return buf.toString('utf8')
  }

  // ⚠ The unauthenticated, UN-BUCKETED one gets its own window: a plain GET with no
  // credential appended 1120 bytes of stack per request before this row.
  test('the PUBLIC availability endpoint costs no stack at all', async () => {
    const log = await appended(async () => {
      for (const query of ['excludeFriendId[a]=1', 'excludeFriendId=1&excludeFriendId=2', 'excludeFriendId[toString]=1']) {
        const res = await ctx.get(`/api/products/cycle/${t13StockCycle}/availability?${query}`)
        expect(res.status(), `?${query} is refused cleanly`).toBe(200)
      }
    })
    expect(log, 'no stack frames on a client-triggerable branch').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from the binder').not.toMatch(/parameter values|can only bind|convert object to primitive/i)
  })

  test('one window over every ADMIN site in this row appends no stack either', async () => {
    const log = await appended(async () => {
      for (const bad of UNBINDABLE) {
        await ctx.post('/api/cycles', { headers: admin(), data: { name: bad } })
        await ctx.patch(`/api/cycles/${t13Cycle}`, { headers: admin(), data: { plan_note: bad, markup_ratio: bad } })
        await ctx.post('/api/products', { headers: admin(), data: { cycle_id: t13Cycle, name: bad } })
        await ctx.patch(`/api/products/${t13Product}`, { headers: admin(), data: { price_250g: bad, stock_limit_g: bad } })
        await ctx.post('/api/bakery-products', { headers: admin(), data: { name: bad, price: bad } })
        await ctx.patch(`/api/bakery-products/${t13Bakery}`, { headers: admin(), data: { name: bad } })
        await ctx.put('/api/admin/settings', { headers: admin(), data: { paymentIban: bad } })
        await ctx.post(`/api/cycles/${t13AuthCycle}/auth`, { data: { password: T13_SHARED, friendId: bad } })
      }
      await ctx.get(`/api/cycles/${t13Cycle}/summary?roastery[a]=1`, { headers: admin() })
      await ctx.get('/api/analytics/rewards?limit[toString]=1', { headers: admin() })
    })
    expect(log, 'no stack frames anywhere in this row').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from the binder').not.toMatch(/parameter values|can only bind|convert object to primitive/i)
  })

  // The counter-assertion that makes the two windows above non-vacuous.
  test('a genuine server fault still logs its full stack', async () => {
    const log = await appended(async () => {
      const res = await ctx.get('/api/cycles', {
        headers: { Origin: 'http://not-an-allowed-origin.example' },
      })
      expect(res.status()).toBe(500)
    })
    expect(log, 'the 500 branch keeps its stack').toMatch(STACK_FRAME)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// FUP-T15 — the SAME bind class, in the files FUP-T13 did not touch.
//
// FUP-T13 closed `cycles.js`, `products.js`, `bakery-products.js`, `admin.js` and
// `rewards.js` with `helpers/bind-value.js`. It also ENUMERATED, with routes and
// auth levels, the sites of the same class living in the other route files and
// recorded them as this row. The mechanism is unchanged and so is the matrix
// (`UNBINDABLE` above, plus the one-element array's own block) — what is new here
// is WHERE, and two of the sites are reachable WITHOUT a session:
//
//   • `POST /api/guest/:token/orders` and `PUT /api/guest/:token/orders/:orderToken`
//     — the app's only unauthenticated WRITE surface. `items[i].product_id` went
//     straight into a bind, so `{"product_id":{}}` was a 500 plus ~870 bytes of
//     stack per request, from anyone holding an office-wide share link.
//   • `POST /api/friends/auth` with the shared password — `friendId` bound
//     directly, ~770 bytes of stack per request.
//
// ⚠ THE STORED VALUE IS THE ASSERTION, NOT THE STATUS, and this row found the
// sharpest instance of that rule so far: `PATCH /api/transactions/:id` with
// `{"amount":["abc"]}` answered a clean **200** and OVERWROTE a real €42.50
// adjustment with the TEXT `"abc"` — a one-element array spreads to exactly the
// arity the statement wants (the FUP-T13 trap), so the ledger silently took a
// value that `SUM(amount)` then reads as 0. Every write site below is read back.
//
// ⚠ IT ALSO FOUND A HALF-WRITE. `PUT /api/orders/cycle/:c/friend/:f` creates the
// order row BEFORE it looks at `items`, so a malformed `product_id` 500'd with an
// empty `draft` order already committed — visible to the admin in the cycle's
// order list as a friend who "ordered nothing". Asserted below by reading the
// order back after the refusal.
//
// ⚠ TWO RECORDED "LATENT" BLOCKERS DID NOT HOLD, and both are asserted here:
//   • `products.js` CSV import — the blocker was "the route requires `req.file`, so
//     the body is multipart and every field is a string". It is not: multer parses
//     fields with the `append-field` package, which honours `roastery[a]=1` and
//     repeated keys. The route answered **400 while ECHOING the binder's own
//     sentence to the client** ("Chyba pri parsovani CSV: Too few parameter values
//     were provided") and logged a full stack.
//   • `vouchers.js` resolve — the blocker was "`voucher.friend_id !== Number(friendId)`
//     is NaN-true ⇒ 403 first". It holds for `{}` and multi-element arrays, but
//     `?friendId[toString]=1` throws INSIDE that very `Number()` call ⇒ 500 + stack,
//     and `?friendId[]=5` passes it and reaches the INSERT.
// (`admin.js:58/68`, FUP-T11's bcrypt exception, WAS re-probed and still holds:
// every shape answers 401 with the route's own message.)

// Messages copied verbatim from the handlers — never re-worded here.
const GUEST_CART_EMPTY = 'Košík je prázdny'
const GUEST_NOTHING_PRICED = 'Žiadnu z položiek sa nepodarilo spracovať. Obnovte stránku a skúste to znova.'
const FRIEND_NOT_FOUND_OR_INACTIVE = 'Priateľ nebol nájdený alebo je neaktívny'
const FRIEND_NOT_FOUND = 'Priateľ nebol nájdený'
const PICKUP_NOT_FOUND = 'Vybrané miesto vyzdvihnutia neexistuje alebo nie je aktívne'
const TX_ORDER_NOT_FOUND = 'Objednávka nebola nájdená alebo nepatrí tomuto priateľovi'
const TX_PAYMENT_AMOUNT = 'Suma musí byť kladné číslo'
const TX_ADJUSTMENT_AMOUNT = 'Suma je povinná a nemôže byť nula'
const VOUCHER_CYCLE_NOT_FOUND = 'Cyklus nebol nájdený'
const VOUCHER_NOT_YOURS = 'Tento voucher nepatrí vám'
const INV_NO_CHANGES = 'Žiadne zmeny'
const FG_NOT_A_ROOT = 'Cieľový priateľ nie je hlavný priateľ'

// T15 fixtures.
let t15Friend // the guest-link host / cart owner / ledger subject
let t15Bearer
let t15Cycle
let t15Product
let t15Pickup
let t15LinkToken
let t15OrderToken // a live guest sub-order under that link
let t15Voucher // a PENDING voucher belonging to t15Friend
let t15Invitation // a pending invitation row
const T15_SHARED = 'e2e-friends-pass'

const t15Bear = () => ({ Authorization: `Bearer ${t15Bearer}` })

test.beforeAll(async () => {
  t15Friend = await createFriend('t15host')
  const username = uniqueUsername('fup15host')
  const setup = await ctx.post(`/api/friends/${t15Friend}/setup-credentials`, {
    headers: shared(),
    data: { username, password: 'fup15HostPass' },
  })
  expect(setup.status(), 'T15 host credentials').toBe(200)
  t15Bearer = (await setup.json()).token

  const cycle = await ctx.post('/api/cycles', {
    headers: admin(),
    data: { name: `FUP15 cycle ${uniq}`, cycle_type: 'coffee' },
  })
  expect(cycle.status(), 'T15 cycle fixture').toBe(201)
  t15Cycle = (await cycle.json()).id

  const product = await ctx.post('/api/products', {
    headers: admin(),
    data: { cycle_id: t15Cycle, name: `FUP15 product ${uniq}`, price_250g: 10, purpose: 'Filter' },
  })
  expect(product.status(), 'T15 product fixture').toBe(201)
  t15Product = (await product.json()).id

  const pickup = await ctx.post('/api/pickup-locations', {
    headers: admin(),
    data: { name: `FUP15 pickup ${uniq}`, address: 'FUP15 adresa' },
  })
  expect(pickup.status(), 'T15 pickup fixture').toBe(201)
  t15Pickup = (await pickup.json()).id

  const link = await ctx.post(`/api/guest-links/cycle/${t15Cycle}`, { headers: t15Bear(), data: {} })
  expect(link.status(), 'T15 guest link fixture').toBe(201)
  t15LinkToken = (await link.json()).link.token

  const sub = await ctx.post(`/api/guest/${t15LinkToken}/orders`, {
    data: {
      guest_name: `FUP15 Hosť ${uniq}`,
      guest_phone: '0900111222',
      items: [{ product_id: t15Product, variant: '250g', quantity: 1 }],
    },
  })
  expect(sub.status(), 'T15 guest sub-order fixture').toBe(201)
  t15OrderToken = (await sub.json()).order.order_token

  // A pending voucher for the resolve block: the friend needs a SUBMITTED order in
  // its own cycle, or `/generate` skips them.
  const vCycle = await ctx.post('/api/cycles', {
    headers: admin(),
    data: { name: `FUP15 voucher ${uniq}`, cycle_type: 'coffee' },
  })
  const vCycleId = (await vCycle.json()).id
  const vProduct = await ctx.post('/api/products', {
    headers: admin(),
    data: { cycle_id: vCycleId, name: `FUP15 vproduct ${uniq}`, price_250g: 10 },
  })
  const vProductId = (await vProduct.json()).id
  await ctx.put(`/api/orders/cycle/${vCycleId}/friend/${t15Friend}`, {
    headers: shared(),
    data: { items: [{ product_id: vProductId, variant: '250g', quantity: 2 }] },
  })
  const submitted = await ctx.post(`/api/orders/cycle/${vCycleId}/friend/${t15Friend}/submit`, {
    headers: shared(),
    data: {},
  })
  expect(submitted.status(), 'T15 voucher source order submitted').toBe(200)
  const generated = await ctx.post('/api/vouchers/generate', {
    headers: admin(),
    data: { source_cycle_id: vCycleId, supplier_discount: 40, applied_discount: 30, friend_ids: [t15Friend] },
  })
  expect(generated.status(), 'T15 voucher fixture').toBe(201)
  t15Voucher = (await generated.json()).vouchers[0].id

  // A pending invitation for the PATCH block. `/register` needs a real invite code,
  // which only the friend's own `/my-code` can produce (friends.js strips it).
  const code = await ctx.get('/api/invitations/my-code', { headers: t15Bear() })
  expect(code.status(), 'T15 invite code').toBe(200)
  const registered = await ctx.post('/api/invitations/register', {
    data: { invite_code: (await code.json()).inviteCode, name: `FUP15 Uchádzač ${uniq}`, phone: uniquePhone() },
  })
  expect(registered.status(), 'T15 invitation fixture').toBe(201)
  const list = await ctx.get('/api/invitations?status=pending', { headers: admin() })
  t15Invitation = (await list.json()).find((i) => i.name === `FUP15 Uchádzač ${uniq}`).id
  expect(t15Invitation, 'T15 invitation row found').toBeTruthy()
})

// Read-back helpers. Each returns the row a write site actually persisted.
const t15Order = async (friendId, cycleId = t15Cycle) =>
  (await ctx.get(`/api/orders/cycle/${cycleId}/friend/${friendId}`, { headers: shared() })).json()
const t15GuestStatus = async () =>
  (await ctx.get(`/api/guest/${t15LinkToken}/orders/${t15OrderToken}`)).json()
const t15Transaction = async (id) => {
  const rows = await (await ctx.get(`/api/transactions/friend/${t15Friend}`, { headers: t15Bear() })).json()
  return rows.find((t) => t.id === id)
}
const t15Invitations = async () => (await ctx.get('/api/invitations', { headers: admin() })).json()
const t15FriendRow = async (id) =>
  (await (await ctx.get('/api/friends', { headers: admin() })).json()).find((f) => f.id === id)

// ── T15.1 POST /api/guest/:token/orders — ⚠ PUBLIC, THE UNAUTHENTICATED WRITE ──
test.describe('FUP-T15 — public guest submit with a non-string items[].product_id', () => {
  for (const productId of UNBINDABLE) {
    test(`product_id ${label(productId)} is a 400, never a 500`, async () => {
      const res = await ctx.post(`/api/guest/${t15LinkToken}/orders`, {
        data: {
          guest_name: `FUP15 shape ${uniq}`,
          guest_phone: '0900111222',
          items: [{ product_id: productId, variant: '250g', quantity: 1 }],
        },
      })
      expect(res.status(), `${label(productId)} must not be a server fault`).toBe(400)
      const body = await res.json()
      // The line is DROPPED (an unresolvable product always was), so the cart is
      // empty and the route answers with its own empty-cart message.
      expect(body.error, "the route's existing empty-cart message").toBe(GUEST_CART_EMPTY)
      expectNoInternals(body)
    })
  }

  test('a MIXED cart still prices the good line and silently drops the malformed one', async () => {
    const res = await ctx.post(`/api/guest/${t15LinkToken}/orders`, {
      data: {
        guest_name: `FUP15 mixed ${uniq}`,
        guest_phone: '0900111333',
        items: [
          { product_id: {}, variant: '250g', quantity: 1 },
          { product_id: t15Product, variant: '250g', quantity: 2 },
        ],
      },
    })
    expect(res.status(), 'the good line still buys').toBe(201)
    const body = await res.json()
    expect(body.items.length, 'exactly one line survived').toBe(1)
    expect(body.items[0].quantity).toBe(2)
    expect(Number(body.order.total), 'only the surviving line is charged').toBeGreaterThan(0)
  })

  test('NOTHING LOOSENED: a well-formed guest order still succeeds', async () => {
    const res = await ctx.post(`/api/guest/${t15LinkToken}/orders`, {
      data: {
        guest_name: `FUP15 ok ${uniq}`,
        guest_phone: '0900111444',
        items: [{ product_id: t15Product, variant: '250g', quantity: 1 }],
      },
    })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.items[0].product_id).toBe(t15Product)
    expect(body.payment, 'the payment reference is still returned on submit').toBeTruthy()
  })
})

// ── T15.2 PUT /api/guest/:token/orders/:orderToken — the same helper, the EDIT ──
//
// ⚠ The edit is the destructive half: before this fix a malformed `product_id`
// 500'd, and after it the line is dropped — which must NOT be read as "the guest
// sent an empty cart", or a typo would cancel a real order. GSO-T4's own guard
// already answers that case; this block proves it is the one that fires.
test.describe('FUP-T15 — public guest EDIT with a non-string items[].product_id', () => {
  for (const productId of UNBINDABLE) {
    test(`product_id ${label(productId)} is a NON-DESTRUCTIVE 400`, async () => {
      const before = await t15GuestStatus()
      const res = await ctx.put(`/api/guest/${t15LinkToken}/orders/${t15OrderToken}`, {
        data: { items: [{ product_id: productId, variant: '250g', quantity: 1 }] },
      })
      expect(res.status(), `${label(productId)} must not be a server fault`).toBe(400)
      const body = await res.json()
      expect(body.error, "GSO-T4's existing nothing-priced message").toBe(GUEST_NOTHING_PRICED)
      expect(body.field).toBe('items')
      expectNoInternals(body)

      // ⚠ THE STORED VALUE: the sub-order must be untouched — same status, same
      // total, same items. A "fix" that let the empty line list through would have
      // CANCELLED it (terminal, per GSO-T4).
      const after = await t15GuestStatus()
      expect(after.order.status, 'still not cancelled').toBe(before.order.status)
      expect(after.order.total, 'the total is unmoved').toBe(before.order.total)
      expect(after.items.length, 'the items survive').toBe(before.items.length)
    })
  }

  test('NOTHING LOOSENED: a real edit still rewrites the cart, and [] still cancels', async () => {
    const edited = await ctx.put(`/api/guest/${t15LinkToken}/orders/${t15OrderToken}`, {
      data: { items: [{ product_id: t15Product, variant: '250g', quantity: 3 }] },
    })
    expect(edited.status()).toBe(200)
    const after = await t15GuestStatus()
    expect(after.items[0].quantity, 'the real edit persisted').toBe(3)
  })
})

// ── T15.3 POST /api/friends/auth — ⚠ PUBLIC behind the shared password ─────────
test.describe('FUP-T15 — shared-password login with a non-string friendId', () => {
  for (const friendId of UNBINDABLE) {
    test(`friendId ${label(friendId)} is a 404, never a 500`, async () => {
      const res = await ctx.post('/api/friends/auth', {
        data: { password: T15_SHARED, friendId },
      })
      expect(res.status(), `${label(friendId)} is refused as an unknown friend`).toBe(404)
      const body = await res.json()
      expect(body.error, "the route's existing message").toBe(FRIEND_NOT_FOUND_OR_INACTIVE)
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: the real pair still authenticates, and no friendId still succeeds', async () => {
    const ok = await ctx.post('/api/friends/auth', {
      data: { password: T15_SHARED, friendId: t15Friend },
    })
    expect(ok.status(), 'a real friendId still mints a session').toBe(200)
    const body = await ok.json()
    expect(body.friend.id).toBe(t15Friend)
    expect(body.token, 'the session token is still issued').toBeTruthy()

    // ⚠ A PRESENT-but-malformed friendId must still ENTER the friend branch. If the
    // guard mapped it to "absent" the route would answer this endpoint's bare
    // `{ success: true }` — a 200 for a login that resolved nobody.
    const absent = await ctx.post('/api/friends/auth', { data: { password: T15_SHARED } })
    expect(absent.status(), 'no friendId is still the shipped password-only check').toBe(200)
    expect((await absent.json()).friend, 'and it resolves no friend').toBeUndefined()

    const wrong = await ctx.post('/api/friends/auth', { data: { password: 'not-it', friendId: {} } })
    expect(wrong.status(), 'password first: a malformed friendId is not an oracle').toBe(401)
  })
})

// ── T15.4 GET /api/friends/cycles?friendId — friend-auth ──────────────────────
test.describe('FUP-T15 — the cycle list with a non-string ?friendId', () => {
  for (const [query, name] of [
    ['friendId[a]=1', '{a:1}'],
    ['friendId=1&friendId=2', "['1','2']"],
    ['friendId[toString]=1', '{toString:1}'],
  ]) {
    test(`?${name} is a 200, never a 500`, async () => {
      const res = await ctx.get(`/api/friends/cycles?${query}`, { headers: shared() })
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body), 'the ordinary cycle list').toBe(true)
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: a real ?friendId still carries that friend\'s own order', async () => {
    const res = await ctx.get(`/api/friends/cycles?friendId=${t15Friend}`, { headers: shared() })
    expect(res.status()).toBe(200)
    const rows = await res.json()
    const withOrder = rows.filter((c) => c.hasOrder)
    expect(withOrder.length, 'the submitted voucher-source order is still reported').toBeGreaterThan(0)
    expect(withOrder[0].orderTotal).toBeGreaterThan(0)
  })
})

// ── T15.5 GET /api/vouchers/pending?friendId — friend-auth ────────────────────
test.describe('FUP-T15 — pending vouchers with a non-string ?friendId', () => {
  for (const [query, name] of [
    ['friendId[a]=1', '{a:1}'],
    ['friendId=1&friendId=2', "['1','2']"],
    ['friendId[toString]=1', '{toString:1}'],
  ]) {
    test(`?${name} is a 200 empty list, never a 500`, async () => {
      const res = await ctx.get(`/api/vouchers/pending?${query}`, { headers: shared() })
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body)).toBe(true)
      expect(body.length, 'an unresolvable friend owns no vouchers').toBe(0)
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: a real ?friendId still lists the pending voucher', async () => {
    const res = await ctx.get(`/api/vouchers/pending?friendId=${t15Friend}`, { headers: shared() })
    expect(res.status()).toBe(200)
    const rows = await res.json()
    expect(rows.some((v) => v.id === t15Voucher), 'the fixture voucher is still visible').toBe(true)
  })
})

// ── T15.6 GET /api/invitations/my-code?friendId — friend-auth, a CAUGHT 500 ────
//
// ⚠ This site's throw is already inside a try/catch that logs `e.message` only, so
// it never cost a stack — but it still answered 500 `Chyba servera` for a malformed
// query string. The status is the bug here; the log was already clean.
test.describe('FUP-T15 — the invite code with a non-string ?friendId', () => {
  for (const [query, name] of [
    ['friendId[a]=1', '{a:1}'],
    ['friendId=1&friendId=2', "['1','2']"],
    ['friendId[toString]=1', '{toString:1}'],
  ]) {
    test(`?${name} is a 404, never a 500`, async () => {
      const res = await ctx.get(`/api/invitations/my-code?${query}`, { headers: shared() })
      expect(res.status()).toBe(404)
      const body = await res.json()
      expect(body.error, "the route's existing not-found message").toBe(FRIEND_NOT_FOUND)
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: a real friend still gets their invite code', async () => {
    const res = await ctx.get('/api/invitations/my-code', { headers: t15Bear() })
    expect(res.status()).toBe(200)
    expect((await res.json()).inviteCode, 'the code is still returned').toBeTruthy()
  })
})

// ── T15.7 POST /api/vouchers/:id/resolve?friendId — the recorded LATENT site ───
test.describe('FUP-T15 — resolving a voucher with a non-string ?friendId', () => {
  for (const [query, name] of [
    ['friendId[a]=1', '{a:1}'],
    ['friendId=1&friendId=2', "['1','2']"],
    ['friendId[toString]=1', '{toString:1}'],
    [`friendId[]=${'PLACEHOLDER'}`, "['<the owner>'] one-element"],
  ]) {
    test(`?${name} is a 403 and mints NO transaction`, async () => {
      const q = query.replace('PLACEHOLDER', String(t15Friend))
      const before = await (await ctx.get(`/api/transactions/friend/${t15Friend}`, { headers: t15Bear() })).json()
      const res = await ctx.post(`/api/vouchers/${t15Voucher}/resolve?${q}`, {
        headers: shared(),
        data: { action: 'accept' },
      })
      expect(res.status(), `${name} must not be a server fault`).toBe(403)
      const body = await res.json()
      expect(body.error, "the route's existing ownership message").toBe(VOUCHER_NOT_YOURS)
      expectNoInternals(body)

      // ⚠ THE STORED VALUE: accepting a voucher CREDITS MONEY. The voucher must
      // still be pending and the ledger must be untouched.
      const pending = await (await ctx.get(`/api/vouchers/pending?friendId=${t15Friend}`, { headers: shared() })).json()
      expect(pending.some((v) => v.id === t15Voucher), 'the voucher is still pending').toBe(true)
      const after = await (await ctx.get(`/api/transactions/friend/${t15Friend}`, { headers: t15Bear() })).json()
      expect(after.length, 'no ledger row was minted').toBe(before.length)
    })
  }

  test('NOTHING LOOSENED: the real owner can still accept, and it credits exactly once', async () => {
    const before = await (await ctx.get(`/api/transactions/friend/${t15Friend}`, { headers: t15Bear() })).json()
    const res = await ctx.post(`/api/vouchers/${t15Voucher}/resolve?friendId=${t15Friend}`, {
      headers: shared(),
      data: { action: 'accept' },
    })
    expect(res.status(), 'the real owner still resolves').toBe(200)
    expect((await res.json()).status).toBe('accepted')
    const after = await (await ctx.get(`/api/transactions/friend/${t15Friend}`, { headers: t15Bear() })).json()
    expect(after.length, 'exactly one credit was written').toBe(before.length + 1)
    expect(after.find((t) => !before.some((b) => b.id === t.id)).friend_id, 'credited to the real friend').toBe(t15Friend)
  })
})

// ── T15.8 PUT /api/orders/cycle/:c/friend/:f — the cart, and the HALF-WRITE ────
test.describe('FUP-T15 — the friend cart with a malformed item', () => {
  // A friend of its own, so the half-write assertion is not confused by a cart the
  // other blocks left behind.
  let cartFriend
  test.beforeAll(async () => {
    cartFriend = await createFriend('t15cart')
  })

  for (const productId of UNBINDABLE) {
    test(`product_id ${label(productId)} drops the line and leaves NO order row`, async () => {
      const res = await ctx.put(`/api/orders/cycle/${t15Cycle}/friend/${cartFriend}`, {
        headers: shared(),
        data: { items: [{ product_id: productId, variant: '250g', quantity: 1 }] },
      })
      expect(res.status(), `${label(productId)} must not be a server fault`).toBe(200)
      expectNoInternals(await res.json())

      // ⚠ THE HALF-WRITE. The handler creates the order row BEFORE it reads
      // `items`, so the pre-fix 500 committed an empty `draft` order that then
      // appeared in the admin's cycle list as a friend who ordered nothing. With
      // the line dropped the cart totals 0 and the route's own "empty cart deletes
      // the order" branch runs, exactly as it does for an unknown product id.
      const row = await t15Order(cartFriend)
      expect(row.order, 'no orphan order row survives the refusal').toBeNull()
      // ⚠ The admin list carries EVERY active friend, with `id: null` for those who
      // have no order — so the assertion is on the order ID, not on the row's
      // presence. Before the fix this friend appeared with a real order id and an
      // empty `items` array.
      const listed = await (await ctx.get(`/api/orders/cycle/${t15Cycle}`, { headers: admin() })).json()
      const seen = listed.find((o) => o.friend_id === cartFriend)
      expect(seen, 'the friend is listed as a placeholder').toBeTruthy()
      expect(seen.id, 'and carries NO order row').toBeNull()
    })
  }

  for (const quantity of UNBINDABLE) {
    test(`quantity ${label(quantity)} drops the line, never a 500`, async () => {
      const res = await ctx.put(`/api/orders/cycle/${t15Cycle}/friend/${cartFriend}`, {
        headers: shared(),
        data: { items: [{ product_id: t15Product, variant: '250g', quantity }] },
      })
      expect(res.status()).toBe(200)
      expect((await t15Order(cartFriend)).order, 'nothing was bought').toBeNull()
    })
  }

  test('a NULL element in items is a 200, never a 500', async () => {
    // ⚠ Not a binder throw but the same body and the same route: `item.quantity`
    // on `null` was a TypeError ⇒ 500 + full stack. `guest.js` already reads its
    // items with `item?.`; these two disagreed about the same shape.
    const res = await ctx.put(`/api/orders/cycle/${t15Cycle}/friend/${cartFriend}`, {
      headers: shared(),
      data: { items: [null] },
    })
    expect(res.status()).toBe(200)
    expectNoInternals(await res.json())
  })

  test('NOTHING LOOSENED: a real cart still saves, and a mixed one keeps the good line', async () => {
    const ok = await ctx.put(`/api/orders/cycle/${t15Cycle}/friend/${cartFriend}`, {
      headers: shared(),
      data: {
        items: [
          { product_id: {}, variant: '250g', quantity: 1 },
          { product_id: t15Product, variant: '250g', quantity: 2 },
        ],
      },
    })
    expect(ok.status()).toBe(200)
    const row = await t15Order(cartFriend)
    expect(row.items.length, 'exactly the good line').toBe(1)
    expect(row.items[0].quantity).toBe(2)
    expect(row.order.total, 'and it is charged').toBeGreaterThan(0)

    const still = await ctx.put(`/api/orders/cycle/${t15Cycle}/friend/${cartFriend}`, {
      headers: shared(),
      data: { items: [{ product_id: t15Product, variant: '250g', quantity: 1 }] },
    })
    expect(still.status()).toBe(200)
    expect((await t15Order(cartFriend)).items[0].quantity).toBe(1)
  })
})

// ── T15.9 POST .../submit — pickup_location_id and pickup_location_note ────────
test.describe('FUP-T15 — order submit with a malformed pickup field', () => {
  let submitFriend
  test.beforeAll(async () => {
    submitFriend = await createFriend('t15submit')
  })
  const seedCart = async () => {
    const res = await ctx.put(`/api/orders/cycle/${t15Cycle}/friend/${submitFriend}`, {
      headers: shared(),
      data: { items: [{ product_id: t15Product, variant: '250g', quantity: 1 }] },
    })
    expect(res.status(), 'cart seeded for the submit').toBe(200)
  }

  for (const pickupId of UNBINDABLE) {
    test(`pickup_location_id ${label(pickupId)} is the route's own 400`, async () => {
      await seedCart()
      const res = await ctx.post(`/api/orders/cycle/${t15Cycle}/friend/${submitFriend}/submit`, {
        headers: shared(),
        data: { pickup_location_id: pickupId },
      })
      expect(res.status(), `${label(pickupId)} must not be a server fault`).toBe(400)
      const body = await res.json()
      expect(body.error, "the route's existing message").toBe(PICKUP_NOT_FOUND)
      expectNoInternals(body)
      // ⚠ THE STORED VALUE: the refusal must not have submitted the order anyway.
      expect((await t15Order(submitFriend)).order.status, 'still a draft').toBe('draft')
    })
  }

  for (const note of UNBINDABLE) {
    test(`pickup_location_note ${label(note)} stores exactly what an ABSENT note stores`, async () => {
      await seedCart()
      const res = await ctx.post(`/api/orders/cycle/${t15Cycle}/friend/${submitFriend}/submit`, {
        headers: shared(),
        data: { pickup_location_note: note },
      })
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.order.pickup_location_note, 'unbindable ⇒ absent ⇒ NULL').toBeNull()
      expectNoInternals(body)
    })
  }

  test('NOTHING LOOSENED: a real pickup id and a real note both still persist', async () => {
    await seedCart()
    const withNote = await ctx.post(`/api/orders/cycle/${t15Cycle}/friend/${submitFriend}/submit`, {
      headers: shared(),
      data: { pickup_location_note: 'Pri fontáne' },
    })
    expect(withNote.status()).toBe(200)
    expect((await withNote.json()).order.pickup_location_note).toBe('Pri fontáne')

    await seedCart()
    const withPickup = await ctx.post(`/api/orders/cycle/${t15Cycle}/friend/${submitFriend}/submit`, {
      headers: shared(),
      data: { pickup_location_id: t15Pickup },
    })
    expect(withPickup.status()).toBe(200)
    expect((await withPickup.json()).order.pickup_location_id).toBe(t15Pickup)

    // The absent-note baseline the block above compares against.
    await seedCart()
    const bare = await ctx.post(`/api/orders/cycle/${t15Cycle}/friend/${submitFriend}/submit`, {
      headers: shared(),
      data: {},
    })
    expect(bare.status()).toBe(200)
    expect((await bare.json()).order.pickup_location_note, 'an absent note is NULL').toBeNull()
  })
})

// ── T15.10 /api/transactions — ⚠ THE LEDGER, and the 200-that-overwrote-money ──
test.describe('FUP-T15 — the transaction ledger with a non-string field', () => {
  for (const friendId of UNBINDABLE) {
    test(`POST /payment friend_id ${label(friendId)} is a 404`, async () => {
      const res = await ctx.post('/api/transactions/payment', {
        headers: admin(),
        data: { friend_id: friendId, amount: 5 },
      })
      expect(res.status()).toBe(404)
      expect((await res.json()).error).toBe(FRIEND_NOT_FOUND)
    })

    test(`POST /adjustment friend_id ${label(friendId)} is a 404`, async () => {
      const res = await ctx.post('/api/transactions/adjustment', {
        headers: admin(),
        data: { friend_id: friendId, amount: 5, note: 'FUP15' },
      })
      expect(res.status()).toBe(404)
      expect((await res.json()).error).toBe(FRIEND_NOT_FOUND)
    })
  }

  for (const orderId of UNBINDABLE) {
    test(`POST /payment order_id ${label(orderId)} is a 404`, async () => {
      const res = await ctx.post('/api/transactions/payment', {
        headers: admin(),
        data: { friend_id: t15Friend, order_id: orderId, amount: 5 },
      })
      expect(res.status()).toBe(404)
      expect((await res.json()).error).toBe(TX_ORDER_NOT_FOUND)
    })
  }

  for (const amount of UNBINDABLE) {
    test(`POST /payment amount ${label(amount)} is the route's own 400`, async () => {
      const res = await ctx.post('/api/transactions/payment', {
        headers: admin(),
        data: { friend_id: t15Friend, amount },
      })
      expect(res.status()).toBe(400)
      expect((await res.json()).error).toBe(TX_PAYMENT_AMOUNT)
    })

    test(`POST /adjustment amount ${label(amount)} is the route's own 400`, async () => {
      const res = await ctx.post('/api/transactions/adjustment', {
        headers: admin(),
        data: { friend_id: t15Friend, amount, note: 'FUP15' },
      })
      expect(res.status()).toBe(400)
      expect((await res.json()).error).toBe(TX_ADJUSTMENT_AMOUNT)
    })
  }

  // ⚠ THE FINDING OF THIS ROW. A one-element array spreads to exactly the arity
  // the statement wants, so `{"amount":["abc"]}` answered 200 and REPLACED a real
  // €42.50 adjustment with the text "abc" — invisible to every status assertion,
  // and `SUM(amount)` then reads it as 0, i.e. the friend's balance silently moves.
  test('⚠ PATCH /:id amount NEVER overwrites a recorded amount', async () => {
    const seeded = await ctx.post('/api/transactions/adjustment', {
      headers: admin(),
      data: { friend_id: t15Friend, amount: 42.5, note: 'FUP15 skutočná suma' },
    })
    expect(seeded.status()).toBe(201)
    const txId = (await seeded.json()).transaction.id
    expect((await t15Transaction(txId)).amount, 'the fixture really carries the money').toBe(42.5)

    for (const amount of [...UNBINDABLE, ['abc'], ['9999']]) {
      const res = await ctx.patch(`/api/transactions/${txId}`, { headers: admin(), data: { amount } })
      expect(res.status(), `${label(amount)} may not be a server fault`).toBeLessThan(500)
      // The column is left out of the SET list, so a request carrying ONLY a
      // malformed amount has nothing to update and falls to the route's own 400.
      expect(res.status(), `${label(amount)} updates nothing`).toBe(400)
      expect((await res.json()).error).toBe(TX_NOTHING_TO_UPDATE)
      expect(
        (await t15Transaction(txId)).amount,
        `⚠ ${label(amount)} must NOT have rewritten the ledger`,
      ).toBe(42.5)
    }

    // NOTHING LOOSENED: a real edit still writes, and the note still edits alone.
    const real = await ctx.patch(`/api/transactions/${txId}`, { headers: admin(), data: { amount: 7.25 } })
    expect(real.status()).toBe(200)
    expect((await t15Transaction(txId)).amount).toBe(7.25)
  })

  test('⚠ a ONE-element array amount is no longer stored bare on the INSERTs either', async () => {
    for (const [path, message] of [
      ['/api/transactions/payment', TX_PAYMENT_AMOUNT],
      ['/api/transactions/adjustment', TX_ADJUSTMENT_AMOUNT],
    ]) {
      const res = await ctx.post(path, {
        headers: admin(),
        data: { friend_id: t15Friend, amount: ['abc'], note: 'FUP15' },
      })
      expect(res.status(), `${path} refuses a one-element array amount`).toBe(400)
      expect((await res.json()).error).toBe(message)
    }
  })

  test('NOTHING LOOSENED: real payments and adjustments still post', async () => {
    const pay = await ctx.post('/api/transactions/payment', {
      headers: admin(),
      data: { friend_id: t15Friend, amount: 3.5, note: 'FUP15 platba' },
    })
    expect(pay.status()).toBe(201)
    expect((await pay.json()).transaction.amount).toBe(3.5)

    const zero = await ctx.post('/api/transactions/payment', {
      headers: admin(),
      data: { friend_id: t15Friend, amount: 0 },
    })
    expect(zero.status(), 'the shipped positive-amount rule is unchanged').toBe(400)
    expect((await zero.json()).error).toBe(TX_PAYMENT_AMOUNT)
  })
})

// ── T15.11 /api/vouchers — generate + the list filters ────────────────────────
test.describe('FUP-T15 — voucher generation with a non-string field', () => {
  for (const cycleId of UNBINDABLE) {
    test(`source_cycle_id ${label(cycleId)} is a 404`, async () => {
      const res = await ctx.post('/api/vouchers/generate', {
        headers: admin(),
        data: { source_cycle_id: cycleId, supplier_discount: 40, applied_discount: 30, friend_ids: [t15Friend] },
      })
      expect(res.status()).toBe(404)
      expect((await res.json()).error).toBe(VOUCHER_CYCLE_NOT_FOUND)
    })
  }

  for (const friendId of UNBINDABLE) {
    test(`a malformed friend_ids element ${label(friendId)} is skipped, never a 500`, async () => {
      const res = await ctx.post('/api/vouchers/generate', {
        headers: admin(),
        data: { source_cycle_id: t15Cycle, supplier_discount: 40, applied_discount: 30, friend_ids: [friendId] },
      })
      expect(res.status()).toBe(201)
      const body = await res.json()
      expect(body.count, 'an unresolvable friend earns no voucher').toBe(0)
    })
  }

  for (const [query, name] of [
    ['status[a]=1', 'status {a:1}'],
    ['status=a&status=b', "status ['a','b']"],
    ['source_cycle_id[a]=1', 'source_cycle_id {a:1}'],
  ]) {
    test(`GET / with ?${name} is a 200, never a 500`, async () => {
      const res = await ctx.get(`/api/vouchers?${query}`, { headers: admin() })
      expect(res.status()).toBe(200)
      expect(Array.isArray(await res.json())).toBe(true)
    })
  }

  test('NOTHING LOOSENED: a real ?status filter still filters', async () => {
    const all = await (await ctx.get('/api/vouchers', { headers: admin() })).json()
    const declined = await (await ctx.get('/api/vouchers?status=declined', { headers: admin() })).json()
    expect(all.length, 'the fixture voucher exists').toBeGreaterThan(0)
    expect(declined.every((v) => v.status === 'declined'), 'the filter is still applied').toBe(true)
    expect(declined.length, 'and it really narrows').toBeLessThan(all.length)
  })
})

// ── T15.12 /api/invitations — the ?status filter and the PATCH ────────────────
test.describe('FUP-T15 — invitations with a non-string field', () => {
  for (const [query, name] of [
    ['status[a]=1', '{a:1}'],
    ['status=a&status=b', "['a','b']"],
    ['status[toString]=1', '{toString:1}'],
  ]) {
    test(`GET / with ?status ${name} is a 200, never a 500`, async () => {
      const res = await ctx.get(`/api/invitations?${query}`, { headers: admin() })
      expect(res.status()).toBe(200)
      expect(Array.isArray(await res.json())).toBe(true)
    })
  }

  for (const status of UNBINDABLE) {
    test(`PATCH /:id status ${label(status)} changes nothing`, async () => {
      const before = (await t15Invitations()).find((i) => i.id === t15Invitation)
      const res = await ctx.patch(`/api/invitations/${t15Invitation}`, {
        headers: admin(),
        data: { status },
      })
      expect(res.status(), `${label(status)} must not be a server fault`).toBe(400)
      expect((await res.json()).error, "the route's existing message").toBe(INV_NO_CHANGES)
      const after = (await t15Invitations()).find((i) => i.id === t15Invitation)
      expect(after.status, '⚠ the invitation status is unmoved').toBe(before.status)
      expect(after.processed_at, 'and it was not marked processed').toBe(before.processed_at)
    })
  }

  for (const note of UNBINDABLE) {
    test(`PATCH /:id admin_note ${label(note)} leaves the note alone`, async () => {
      const before = (await t15Invitations()).find((i) => i.id === t15Invitation)
      const res = await ctx.patch(`/api/invitations/${t15Invitation}`, {
        headers: admin(),
        data: { admin_note: note },
      })
      expect(res.status()).toBe(400)
      expect((await res.json()).error).toBe(INV_NO_CHANGES)
      const after = (await t15Invitations()).find((i) => i.id === t15Invitation)
      expect(after.admin_note, '⚠ the recorded note is unmoved').toBe(before.admin_note)
    })
  }

  test('NOTHING LOOSENED: real values still update, and a bad status STRING keeps its answer', async () => {
    const noted = await ctx.patch(`/api/invitations/${t15Invitation}`, {
      headers: admin(),
      data: { admin_note: 'FUP15 poznámka správcu' },
    })
    expect(noted.status()).toBe(200)
    expect((await t15Invitations()).find((i) => i.id === t15Invitation).admin_note).toBe('FUP15 poznámka správcu')

    // ⚠ This row guards the BIND, not the value space: `status: 'bogus'` is a
    // perfectly bindable string that the table's CHECK constraint refuses, and it
    // keeps the answer it has always had. Inventing a status enum here would be a
    // behaviour change hiding inside a bug fix.
    const bogus = await ctx.patch(`/api/invitations/${t15Invitation}`, {
      headers: admin(),
      data: { status: 'bogus' },
    })
    expect(bogus.status(), 'unchanged: a bindable-but-invalid status still fails as before').toBe(500)

    const real = await ctx.patch(`/api/invitations/${t15Invitation}`, {
      headers: admin(),
      data: { status: 'rejected' },
    })
    expect(real.status()).toBe(200)
    expect((await t15Invitations()).find((i) => i.id === t15Invitation).status).toBe('rejected')
  })
})

// ── T15.13 /api/friend-groups — assignment must never silently UNASSIGN ────────
test.describe('FUP-T15 — friend groups with a non-string field', () => {
  let root
  let member
  test.beforeAll(async () => {
    root = await createFriend('t15root')
    member = await createFriend('t15member')
    const promoted = await ctx.patch(`/api/friend-groups/${root}/root-status`, {
      headers: admin(),
      data: { isRoot: true },
    })
    expect(promoted.status(), 'T15 root fixture').toBe(200)
    const assigned = await ctx.patch(`/api/friend-groups/${member}/assign-root`, {
      headers: admin(),
      data: { rootFriendId: root },
    })
    expect(assigned.status(), 'T15 membership fixture').toBe(200)
    expect((await t15FriendRow(member)).root_friend_id, 'the member really belongs to the root').toBe(root)
  })

  for (const rootFriendId of UNBINDABLE) {
    test(`PATCH /:id/assign-root rootFriendId ${label(rootFriendId)} keeps the membership`, async () => {
      const res = await ctx.patch(`/api/friend-groups/${member}/assign-root`, {
        headers: admin(),
        data: { rootFriendId },
      })
      expect(res.status(), `${label(rootFriendId)} must not be a server fault`).toBe(400)
      expect((await res.json()).error, "the route's existing message").toBe(FG_NOT_A_ROOT)
      // ⚠ A guard that treated the value as ABSENT would fall through to
      // `rootFriendId || null` and UNASSIGN the friend with a 200.
      expect((await t15FriendRow(member)).root_friend_id, '⚠ still in the group').toBe(root)
    })

    test(`PATCH /batch-assign rootFriendId ${label(rootFriendId)} keeps every membership`, async () => {
      const res = await ctx.patch('/api/friend-groups/batch-assign', {
        headers: admin(),
        data: { friendIds: [member], rootFriendId },
      })
      expect(res.status()).toBe(400)
      expect((await res.json()).error).toBe(FG_NOT_A_ROOT)
      expect((await t15FriendRow(member)).root_friend_id, '⚠ still in the group').toBe(root)
    })
  }

  for (const friendId of UNBINDABLE) {
    test(`PATCH /batch-assign friendIds element ${label(friendId)} is skipped`, async () => {
      const res = await ctx.patch('/api/friend-groups/batch-assign', {
        headers: admin(),
        data: { friendIds: [friendId], rootFriendId: root },
      })
      expect(res.status(), `${label(friendId)} must not be a server fault`).toBe(200)
      expect((await res.json()).success).toBe(true)
    })
  }

  test('NOTHING LOOSENED: real assignment, real batch assignment and an explicit null still work', async () => {
    const cleared = await ctx.patch(`/api/friend-groups/${member}/assign-root`, {
      headers: admin(),
      data: { rootFriendId: null },
    })
    expect(cleared.status()).toBe(200)
    expect((await t15FriendRow(member)).root_friend_id, 'an explicit null still unassigns').toBeNull()

    const batched = await ctx.patch('/api/friend-groups/batch-assign', {
      headers: admin(),
      data: { friendIds: [member], rootFriendId: root },
    })
    expect(batched.status()).toBe(200)
    expect((await t15FriendRow(member)).root_friend_id, 'and a real batch assign still assigns').toBe(root)
  })
})

// ── T15.14 POST /api/products/import/:cycleId — ⚠ the FALSE "multipart" blocker ─
//
// The recorded blocker was "the route requires `req.file`, so the body is multipart
// and every field is a string". multer parses fields through `append-field`, which
// honours bracket notation and repeated keys — so `roastery[a]=1` really did arrive
// as an object, was bound into the per-row INSERT, and the route's own try/catch
// answered 400 with the BINDER'S SENTENCE echoed to the client, after logging a
// full stack.
test.describe('FUP-T15 — the CSV import with a non-string multipart roastery', () => {
  const BOUNDARY = '----fup15boundary'
  const CSV = 'Name,Price250g\nFUP15 CSV Produkt,9.90\n'
  const multipart = (fieldParts) =>
    fieldParts +
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="p.csv"\r\n` +
    `Content-Type: text/csv\r\n\r\n${CSV}\r\n--${BOUNDARY}--\r\n`
  const post = (cycleId, body) =>
    ctx.post(`/api/products/import/${cycleId}`, {
      headers: { ...admin(), 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
      data: Buffer.from(body, 'utf8'),
    })

  for (const [name, part] of [
    ['roastery[a]=1 ⇒ {a:"1"}', `--${BOUNDARY}\r\nContent-Disposition: form-data; name="roastery[a]"\r\n\r\n1\r\n`],
    [
      "a repeated roastery ⇒ ['a','b']",
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="roastery"\r\n\r\na\r\n` +
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="roastery"\r\n\r\nb\r\n`,
    ],
    ["roastery[]=a ⇒ ['a']", `--${BOUNDARY}\r\nContent-Disposition: form-data; name="roastery[]"\r\n\r\na\r\n`],
  ]) {
    test(`${name} imports with NO roastery and leaks nothing`, async () => {
      const cycle = await ctx.post('/api/cycles', { headers: admin(), data: { name: `FUP15 csv ${uniq} ${nextSeq()}` } })
      const cycleId = (await cycle.json()).id
      const res = await post(cycleId, multipart(part))
      expect(res.status(), `${name} still imports`).toBe(201)
      const body = await res.json()
      // ⚠ The old 400 said "Chyba pri parsovani CSV: Too few parameter values were
      // provided" — the binder's own words, on an admin screen.
      expect(JSON.stringify(body), 'no binder text reaches the client').not.toMatch(
        /parameter values|can only bind|convert object to primitive/i,
      )
      expect(body.products.length, 'the row really imported').toBe(1)
      expect(body.products[0].roastery, 'unbindable ⇒ absent ⇒ NULL').toBeNull()
    })
  }

  test('NOTHING LOOSENED: a real roastery string still lands on every imported row', async () => {
    const cycle = await ctx.post('/api/cycles', { headers: admin(), data: { name: `FUP15 csv ok ${uniq}` } })
    const cycleId = (await cycle.json()).id
    const part = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="roastery"\r\n\r\nFUP15 Pražiareň\r\n`
    const res = await post(cycleId, multipart(part))
    expect(res.status()).toBe(201)
    expect((await res.json()).products[0].roastery).toBe('FUP15 Pražiareň')
  })
})

// ── T15.16 The ONE-element array — the SILENT SUCCESSES, recorded not hidden ───
//
// ⚠ `UNBINDABLE` deliberately excludes `['abc']`, because it does not crash: an
// ARRAY argument is SPREAD into the positional slots, so a one-element array
// supplies exactly the arity a single-`?` statement wants and the bare string
// lands in the column. Every site in this row therefore had a shape that was a
// silent SUCCESS rather than a 500, and closing the class necessarily changes it.
// The ledger's case has its own block above (it OVERWROTE money); these are the
// remaining ones that actually did something, each asserted by outcome.
test.describe('FUP-T15 — a ONE-element array is no longer silently unwrapped', () => {
  test('the public shared-password login no longer signs in ["<friend id>"]', async () => {
    const res = await ctx.post('/api/friends/auth', {
      data: { password: T15_SHARED, friendId: [String(t15Friend)] },
    })
    // Before: `.get(['5'])` spread to the statement's single slot, matched friend 5
    // and MINTED A SESSION for them.
    expect(res.status(), 'refused as an unknown friend').toBe(404)
    const body = await res.json()
    expect(body.error).toBe(FRIEND_NOT_FOUND_OR_INACTIVE)
    expect(body.token, 'and no session token is issued').toBeUndefined()
  })

  test('the friend cart no longer buys a product identified as ["<product id>"]', async () => {
    const buyer = await createFriend('t15onearr')
    const res = await ctx.put(`/api/orders/cycle/${t15Cycle}/friend/${buyer}`, {
      headers: shared(),
      data: { items: [{ product_id: [String(t15Product)], variant: '250g', quantity: 1 }] },
    })
    expect(res.status()).toBe(200)
    expect((await t15Order(buyer)).order, 'the line was dropped, nothing was bought').toBeNull()
  })

  test('the invite code is no longer handed out for ?friendId[]=<friend id>', async () => {
    const res = await ctx.get(`/api/invitations/my-code?friendId[]=${t15Friend}`, { headers: shared() })
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.error).toBe(FRIEND_NOT_FOUND)
    expect(body.inviteCode, 'the shareable secret is not returned').toBeUndefined()
  })

  test('a batch assignment no longer moves a friend identified as ["<friend id>"]', async () => {
    const root2 = await createFriend('t15root2')
    const member2 = await createFriend('t15member2')
    expect((await ctx.patch(`/api/friend-groups/${root2}/root-status`, {
      headers: admin(), data: { isRoot: true },
    })).status()).toBe(200)

    const res = await ctx.patch('/api/friend-groups/batch-assign', {
      headers: admin(),
      data: { friendIds: [[String(member2)]], rootFriendId: root2 },
    })
    expect(res.status()).toBe(200)
    expect((await t15FriendRow(member2)).root_friend_id, 'the element resolved nobody').toBeNull()

    // NOTHING LOOSENED: the same call with a plain id still assigns.
    expect((await ctx.patch('/api/friend-groups/batch-assign', {
      headers: admin(), data: { friendIds: [member2], rootFriendId: root2 },
    })).status()).toBe(200)
    expect((await t15FriendRow(member2)).root_friend_id).toBe(root2)
  })
})

// ── T15.15 The log half ───────────────────────────────────────────────────────
test.describe('FUP-T15 — no stack reaches the log for any site in this row', () => {
  test.skip(!SERVER_LOG, 'set SERVER_LOG=<backend log path> to exercise the log assertions')

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
    await new Promise((r) => setTimeout(r, 400))
    const fh = await fs.promises.open(SERVER_LOG, 'r')
    const size = (await fh.stat()).size
    const buf = Buffer.alloc(Math.max(0, size - before))
    if (buf.length) await fh.read(buf, 0, buf.length, before)
    await fh.close()
    return buf.toString('utf8')
  }

  const noBinderText = (log) => {
    expect(log, 'no stack frames on a client-triggerable branch').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from the binder').not.toMatch(
      /parameter values|can only bind|convert object to primitive/i,
    )
  }

  // ⚠ The two UNAUTHENTICATED sites get their own windows. `POST /api/guest/:token/orders`
  // is the app's only anonymous write; before this row each malformed body cost ~870
  // bytes of stack, and the link is shared at office scale.
  test('the PUBLIC guest submit and edit cost no stack at all', async () => {
    const log = await appended(async () => {
      for (const bad of UNBINDABLE) {
        const submit = await ctx.post(`/api/guest/${t15LinkToken}/orders`, {
          data: {
            guest_name: `FUP15 log ${uniq}`,
            guest_phone: '0900111555',
            items: [{ product_id: bad, variant: '250g', quantity: 1 }],
          },
        })
        expect(submit.status(), 'the anonymous write is refused cleanly').toBe(400)
        const edit = await ctx.put(`/api/guest/${t15LinkToken}/orders/${t15OrderToken}`, {
          data: { items: [{ product_id: bad, variant: '250g', quantity: 1 }] },
        })
        expect(edit.status(), 'and so is the anonymous edit').toBe(400)
      }
    })
    noBinderText(log)
  })

  test('the PUBLIC shared-password login costs no stack at all', async () => {
    const log = await appended(async () => {
      for (const bad of UNBINDABLE) {
        const res = await ctx.post('/api/friends/auth', { data: { password: T15_SHARED, friendId: bad } })
        expect(res.status(), 'refused as an unknown friend').toBe(404)
      }
    })
    noBinderText(log)
  })

  test('one window over every remaining site in this row appends no stack either', async () => {
    const log = await appended(async () => {
      for (const bad of UNBINDABLE) {
        await ctx.get(`/api/friends/cycles?friendId[a]=1`, { headers: shared() })
        await ctx.get('/api/vouchers/pending?friendId[toString]=1', { headers: shared() })
        await ctx.get('/api/invitations/my-code?friendId[a]=1', { headers: shared() })
        await ctx.post(`/api/vouchers/${t15Voucher}/resolve?friendId[toString]=1`, {
          headers: shared(),
          data: { action: 'accept' },
        })
        await ctx.put(`/api/orders/cycle/${t15Cycle}/friend/${t15Friend}`, {
          headers: shared(),
          data: { items: [{ product_id: bad, variant: '250g', quantity: bad }, null] },
        })
        await ctx.post('/api/transactions/payment', { headers: admin(), data: { friend_id: bad, amount: bad } })
        await ctx.post('/api/transactions/adjustment', { headers: admin(), data: { friend_id: t15Friend, order_id: bad, amount: bad, note: 'x' } })
        await ctx.patch(`/api/transactions/${1}`, { headers: admin(), data: { amount: bad } })
        await ctx.post('/api/vouchers/generate', {
          headers: admin(),
          data: { source_cycle_id: bad, supplier_discount: 40, applied_discount: 30, friend_ids: [bad] },
        })
        await ctx.get('/api/vouchers?status[a]=1', { headers: admin() })
        await ctx.get('/api/invitations?status[a]=1', { headers: admin() })
        await ctx.patch(`/api/invitations/${t15Invitation}`, { headers: admin(), data: { status: bad, admin_note: bad } })
        await ctx.patch('/api/friend-groups/batch-assign', { headers: admin(), data: { friendIds: [bad], rootFriendId: bad } })
        await ctx.patch(`/api/friend-groups/${t15Friend}/assign-root`, { headers: admin(), data: { rootFriendId: bad } })
      }
    })
    noBinderText(log)
  })

  // The counter-assertion that makes the three windows above non-vacuous.
  test('a genuine server fault still logs its full stack', async () => {
    const log = await appended(async () => {
      const res = await ctx.get('/api/cycles', {
        headers: { Origin: 'http://not-an-allowed-origin.example' },
      })
      expect(res.status()).toBe(500)
    })
    expect(log, 'the 500 branch keeps its stack').toMatch(STACK_FRAME)
  })
})
