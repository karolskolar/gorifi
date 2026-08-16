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
