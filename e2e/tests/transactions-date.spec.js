import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'

// FUP-T14 — `transactions.js` date handling. TWO distinct bugs on one expression,
// and NEITHER of them is the FUP-T12 non-string class.
//
//   `const createdAt = date ? new Date(date).toISOString() : <default>`
//   — `backend/src/routes/transactions.js:68` (POST /transactions/payment)
//   — `backend/src/routes/transactions.js:179` (PATCH /transactions/:id)
//
// ⚠ WHY THIS IS ITS OWN FILE AND NOT A BLOCK IN `nonstring-body-shape.spec.js`.
// That file's entire premise — stated in its header and encoded in its `MALFORMED`
// matrix — is "a string METHOD called on a non-string throws a TypeError". Neither
// half of this row fits it:
//   (1) the CRASH fires for an ORDINARY STRING. `{"date":"garbage"}` is a perfectly
//       well-typed string; `new Date('garbage')` is an Invalid Date and `.toISOString()`
//       on one throws `RangeError: Invalid time value`. FUP-T12 correctly classed this
//       as a different family and left it alone. A `typeof === 'string'` guard — the
//       whole fix of that row — closes NONE of it.
//   (2) the SILENT half is the opposite shape of bug: `{"date":12345678}` and
//       `{"date":true}` were ACCEPTED (201/200) and stored `1970-01-01T…`. Nothing
//       throws, no log line, no bad status — a plausible-looking wrong date written
//       into the ledger friends' balances are computed from.
// Folding either into a file whose header says "the throw comes from a language
// builtin" would make that header false. The counter-assertions are date-semantics
// too (a valid ISO string must round-trip byte-identically; an absent date must still
// default to now on POST and leave `created_at` untouched on PATCH), which share no
// helper with the shape matrix.
//
// ⚠ THIS IS MONEY, SO THE POLICY IS "REFUSE, NEVER GUESS". Both call sites in the app
// (`AddPaymentDialog.vue` / `EditTransactionDialog.vue`, through `api.js addPayment`
// and `updateTransaction`) send `selectedDate.value.toISOString()` — a full ISO 8601
// string, and nothing else, ever. So a parsable STRING is the whole legitimate surface
// and a NUMBER is refused deliberately: no caller sends one, and silently storing the
// epoch is strictly worse than a 400 the admin can see.
//
// ⚠ NOTHING MAY LOOSEN, AND THE ASSERTION IS THE STORED VALUE — not the status.
// FUP-T13 found a malformed PATCH answering 200 while REMOVING a stock limit; FUP-T12
// found `String()` writing `"[object Object]"` into an audit field. Every refusal below
// is therefore paired with a read-back of `created_at` (and of the balance) proving the
// ledger did not move, and every accepted date is read back and compared exactly.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'

// ── The refusal message, REUSED VERBATIM, never invented. ────────────────────
// `backend/src/index.js:223` already answers `Neplatna poziadavka` on a 400 for these
// very routes (it is what an unparsable body gets today), so this is the string the
// endpoint already returns for a body it cannot use. Module 09's copy sign-off is
// still outstanding — a date-specific sentence would be a new user-visible string.
const BAD_REQUEST = 'Neplatna poziadavka'
// The two shipped 400s that must keep firing exactly as before.
const TX_NOTHING_TO_UPDATE = 'Žiadne údaje na aktualizáciu'
const TX_AMOUNT_POSITIVE = 'Suma musí byť kladné číslo'

// ⚠ THE DATE MATRIX. Split in two, because the two halves fail in opposite ways and a
// suite that mixed them could pass vacuously.
//
//   CRASHING — every one of these made `.toISOString()` throw ⇒ 500 + ~1071 B of stack.
//   `'garbage'` is the ordinary-string instance the row was opened for; `[]` stringifies
//   to `''` and `{}` to `'[object Object]'`, both Invalid Dates.
const CRASHING_DATES = ['garbage', '2026-13-45', '', ' ', {}, [], ['a', 'b'], { toString: 1 }]
//
//   SILENT — every one of these was ACCEPTED and stored a 1970 timestamp. This is the
//   half no status assertion can see, which is why each is paired with a read-back.
//   ⚠ `''` and `[]` are deliberately NOT here: `''` is falsy (it takes the default
//   branch, and that behaviour is preserved) and `[]` crashed rather than storing.
const SILENT_EPOCH_DATES = [12345678, 0.5, true, 1e12]

// Everything that must be REFUSED. Only `''` is dropped: it is the one falsy member of
// `CRASHING_DATES` and therefore the one that legitimately still succeeds.
const ALL_BAD_DATES = [...CRASHING_DATES.filter((d) => d !== ''), ...SILENT_EPOCH_DATES]

const label = (v) => JSON.stringify(v)

// Nothing from the RangeError may reach the client either — a 400 echoing
// "Invalid time value" would be a nicer-status version of the same leak.
function expectNoInternals(body) {
  const raw = JSON.stringify(body)
  expect(raw, 'no internals in the response').not.toMatch(
    /Invalid time value|RangeError|TypeError|is not a function/i,
  )
  expect(raw, 'no stack trace in the response').not.toMatch(/at .*\.js|node_modules/)
}

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx
let adminToken
let friendId

const admin = () => ({ 'X-Admin-Token': adminToken })
// ⚠ `GET /transactions/friend/:id` is FRIEND-authenticated (`requireFriendOwner`), not
// admin — an admin token is refused there. The shared password is the read path in
// legacy mode, which is the mode the shared gate DB runs in.
const shared = () => ({ 'X-Friends-Password': FRIENDS_PASSWORD })

/** The full ledger for the fixture friend, newest first. */
async function ledger() {
  const res = await ctx.get(`/api/transactions/friend/${friendId}`, { headers: shared() })
  expect(res.status(), 'the fixture ledger is readable').toBe(200)
  return res.json()
}

/** One row, read back from the DB rather than trusted from a mutation response. */
async function storedRow(id) {
  return (await ledger()).find((t) => t.id === id)
}

async function balance() {
  return (await ledger()).reduce((sum, t) => sum + t.amount, 0)
}

/** A fresh adjustment to mutate, so no test depends on another's leftovers. */
async function freshTransaction(note) {
  const res = await ctx.post('/api/transactions/adjustment', {
    headers: admin(),
    data: { friend_id: friendId, amount: 1, note: `FUP14 ${note} ${uniq}` },
  })
  expect(res.status(), `transaction fixture (${note})`).toBe(201)
  return (await res.json()).transaction
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })

  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login for the fixtures').toBe(200)
  adminToken = (await login.json()).token

  const friend = await ctx.post('/api/friends', {
    headers: admin(),
    data: { name: `FUP14 date ${uniq}` },
  })
  expect(friend.status(), 'friend fixture created').toBe(201)
  friendId = (await friend.json()).id
})

test.afterAll(async () => { await ctx?.dispose() })

// ── 1. POST /api/transactions/payment — bug 1, the crash ─────────────────────

test.describe('POST /transactions/payment — an unusable date is refused, not thrown on', () => {
  for (const date of CRASHING_DATES) {
    test(`${label(date)} answers 400, not 500`, async () => {
      const before = await balance()
      const res = await ctx.post('/api/transactions/payment', {
        headers: admin(),
        data: { friend_id: friendId, amount: 5, date },
      })
      const body = await res.json()
      // ⚠ `''` and `' '` are here for a REASON and their expectation differs: `''` is
      // FALSY, so it takes the shipped default-to-now branch and must still be a 201.
      // Whitespace is truthy and unparsable, so it is refused. Getting these two the
      // same way round would be a behaviour change hiding inside a bug fix.
      if (date === '') {
        expect(res.status(), 'an empty date keeps its shipped "no date given" meaning').toBe(201)
        return
      }
      expect(res.status(), `${label(date)} is a client error`).toBe(400)
      expect(body.error, 'and it reuses the route-family message').toBe(BAD_REQUEST)
      expectNoInternals(body)
      expect(await balance(), 'a refused payment moves no money').toBe(before)
    })
  }

  test('a refused date writes NO row at all — the read-back, not the status', async () => {
    const before = await ledger()
    for (const date of CRASHING_DATES.filter((d) => d !== '')) {
      await ctx.post('/api/transactions/payment', {
        headers: admin(),
        data: { friend_id: friendId, amount: 5, date },
      })
    }
    const after = await ledger()
    expect(after.length, 'no transaction landed for any refused date').toBe(before.length)
  })
})

// ── 2. POST /api/transactions/payment — bug 2, the silent epoch ──────────────
//
// ⚠ THE WORSE OF THE TWO. These all answered 201 and stored `1970-01-01T…`: a
// plausible-looking date, in the right column, in a financial ledger, with no error
// anywhere. A status-only suite passes on every one of them.

test.describe('POST /transactions/payment — a numeric date never becomes 1970', () => {
  for (const date of SILENT_EPOCH_DATES) {
    test(`${label(date)} is refused rather than stored as the epoch`, async () => {
      const before = await ledger()
      const res = await ctx.post('/api/transactions/payment', {
        headers: admin(),
        data: { friend_id: friendId, amount: 7, date },
      })
      const body = await res.json()
      expect(res.status(), `${label(date)} is not a legitimate date on this route`).toBe(400)
      expect(body.error).toBe(BAD_REQUEST)
      expectNoInternals(body)

      const after = await ledger()
      expect(after.length, 'and nothing was written').toBe(before.length)
      expect(
        after.filter((t) => String(t.created_at).startsWith('1970')),
        'no 1970 row exists anywhere in this friend\'s ledger',
      ).toEqual([])
    })
  }
})

// ── 3. PATCH /api/transactions/:id — the same two bugs on an UPDATE ──────────
//
// ⚠ Worse here than on the POST, because a PATCH edits a row that already exists: the
// failure mode is not "a bad row appears" but "a good row's timestamp is rewritten".

test.describe('PATCH /transactions/:id — a bad date leaves created_at untouched', () => {
  for (const date of ALL_BAD_DATES) {
    test(`${label(date)} is refused and the stored created_at does not move`, async () => {
      const tx = await freshTransaction(`patch ${label(date)}`)
      const original = (await storedRow(tx.id)).created_at

      const res = await ctx.patch(`/api/transactions/${tx.id}`, {
        headers: admin(),
        data: { date },
      })
      const body = await res.json()
      expect(res.status(), `${label(date)} is a client error on the PATCH too`).toBe(400)
      expect(body.error).toBe(BAD_REQUEST)
      expectNoInternals(body)

      // ⚠ THE ASSERTION THAT MATTERS: the row, re-read from the database.
      expect((await storedRow(tx.id)).created_at, 'created_at is exactly as it was').toBe(original)
    })
  }

  test('a malformed date does NOT degrade into "nothing to update"', async () => {
    // The route builds its SET list conditionally, so a refusal implemented by simply
    // skipping the column would answer 400 `Žiadne údaje na aktualizáciu` — the same
    // status, a different meaning, and silently a no-op the admin would read as
    // "I sent nothing" rather than "your date was rejected".
    const tx = await freshTransaction('degrade')
    const res = await ctx.patch(`/api/transactions/${tx.id}`, {
      headers: admin(),
      data: { date: 'garbage' },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error, 'the date is named as the problem, not the empty body')
      .toBe(BAD_REQUEST)
  })

  test('a bad date does not sneak the OTHER fields through', async () => {
    // A guard placed after the amount/note pushes would refuse the date while the
    // update had already been built — or, worse, apply the amount and drop the date.
    const tx = await freshTransaction('atomic')
    const original = await storedRow(tx.id)
    const res = await ctx.patch(`/api/transactions/${tx.id}`, {
      headers: admin(),
      data: { amount: 99, note: 'FUP14 nová poznámka', date: 12345678 },
    })
    expect(res.status()).toBe(400)
    const after = await storedRow(tx.id)
    expect(after.amount, 'the amount is unchanged').toBe(original.amount)
    expect(after.note, 'the note is unchanged').toBe(original.note)
    expect(after.created_at, 'and so is created_at').toBe(original.created_at)
  })
})

// ── 4. NOTHING LOOSENED — every accepted shape still behaves exactly as it did ─

test.describe('the shipped behaviour is preserved byte for byte', () => {
  test('a full ISO string — what the two dialogs actually send — round-trips exactly', async () => {
    const iso = '2026-03-04T10:11:12.345Z'
    const res = await ctx.post('/api/transactions/payment', {
      headers: admin(),
      data: { friend_id: friendId, amount: 3, date: iso },
    })
    expect(res.status(), 'a real payment still succeeds').toBe(201)
    const { transaction } = await res.json()
    expect(transaction.created_at, 'the response carries the value sent').toBe(iso)
    expect((await storedRow(transaction.id)).created_at, 'and so does the stored row').toBe(iso)
  })

  test('a date-only YYYY-MM-DD string still normalises to UTC midnight, as before', async () => {
    // No shipped caller sends this shape, but `new Date('2026-03-04').toISOString()`
    // accepted it before this row, so refusing it now would be a tightening the row
    // did not ask for.
    const res = await ctx.post('/api/transactions/payment', {
      headers: admin(),
      data: { friend_id: friendId, amount: 3, date: '2026-03-04' },
    })
    expect(res.status()).toBe(201)
    const { transaction } = await res.json()
    expect(transaction.created_at).toBe('2026-03-04T00:00:00.000Z')
    expect((await storedRow(transaction.id)).created_at).toBe('2026-03-04T00:00:00.000Z')
  })

  test('POST with no date at all still defaults to now', async () => {
    const sent = Date.now()
    const res = await ctx.post('/api/transactions/payment', {
      headers: admin(),
      data: { friend_id: friendId, amount: 2 },
    })
    expect(res.status()).toBe(201)
    const { transaction } = await res.json()
    const stored = Date.parse((await storedRow(transaction.id)).created_at)
    expect(Number.isFinite(stored), 'a real timestamp was stored').toBe(true)
    expect(Math.abs(stored - sent), 'and it is now, within a minute').toBeLessThan(60_000)
  })

  for (const date of [null, '', 0]) {
    test(`POST with a FALSY date (${label(date)}) still means "no date given" ⇒ now`, async () => {
      // ⚠ `undefined` and `null`/`''`/`0` are not the same thing on this route, and the
      // difference is shipped behaviour: the falsy values take the default branch.
      // Refusing them would be a tightening, so they are asserted, not swept in.
      const sent = Date.now()
      const res = await ctx.post('/api/transactions/payment', {
        headers: admin(),
        data: { friend_id: friendId, amount: 2, date },
      })
      expect(res.status(), `${label(date)} keeps taking the default branch`).toBe(201)
      const { transaction } = await res.json()
      const stored = Date.parse((await storedRow(transaction.id)).created_at)
      expect(Math.abs(stored - sent)).toBeLessThan(60_000)
    })
  }

  test('PATCH with a valid date still rewrites created_at', async () => {
    const tx = await freshTransaction('valid patch')
    const iso = '2025-12-24T18:30:00.000Z'
    const res = await ctx.patch(`/api/transactions/${tx.id}`, { headers: admin(), data: { date: iso } })
    expect(res.status()).toBe(200)
    expect((await res.json()).transaction.created_at).toBe(iso)
    expect((await storedRow(tx.id)).created_at, 'read back from the database').toBe(iso)
  })

  for (const date of [null, '']) {
    test(`PATCH with a FALSY date (${label(date)}) is still a 200 that changes nothing`, async () => {
      // ⚠ THE `date !== undefined` GATE IS THE SHIPPED DISTINCTION. A falsy-but-present
      // date enters the branch and writes `created_at` back to itself, so the request
      // is a 200 — NOT the `Žiadne údaje na aktualizáciu` 400 an absent date would get.
      const tx = await freshTransaction(`falsy patch ${label(date)}`)
      const original = (await storedRow(tx.id)).created_at
      const res = await ctx.patch(`/api/transactions/${tx.id}`, { headers: admin(), data: { date } })
      expect(res.status(), 'present-but-falsy is still a successful no-op').toBe(200)
      expect((await storedRow(tx.id)).created_at, 'and created_at is unchanged').toBe(original)
    })
  }

  test('PATCH with no date key leaves created_at alone and updates the rest', async () => {
    const tx = await freshTransaction('no date key')
    const original = (await storedRow(tx.id)).created_at
    const res = await ctx.patch(`/api/transactions/${tx.id}`, {
      headers: admin(),
      data: { amount: 42 },
    })
    expect(res.status()).toBe(200)
    const after = await storedRow(tx.id)
    expect(after.amount, 'the amount really changed').toBe(42)
    expect(after.created_at, 'created_at was never in the SET list').toBe(original)
  })

  test('PATCH with an empty body still answers the route\'s own 400', async () => {
    const tx = await freshTransaction('empty body')
    const res = await ctx.patch(`/api/transactions/${tx.id}`, { headers: admin(), data: {} })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe(TX_NOTHING_TO_UPDATE)
  })

  test('the amount rule is untouched by the date guard', async () => {
    const res = await ctx.post('/api/transactions/payment', {
      headers: admin(),
      data: { friend_id: friendId, amount: 0, date: '2026-03-04T10:00:00.000Z' },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error, 'the amount is still refused first').toBe(TX_AMOUNT_POSITIVE)
  })

  test('POST /transactions/adjustment is untouched — it never had a date field', async () => {
    // The adjustment route takes no `date` and must keep ignoring one entirely; a
    // guard written in the wrong place would start refusing bodies it used to accept.
    const res = await ctx.post('/api/transactions/adjustment', {
      headers: admin(),
      data: { friend_id: friendId, amount: 1, note: 'FUP14 adjustment', date: 'garbage' },
    })
    expect(res.status(), 'an ignored `date` is still ignored').toBe(201)
  })
})

// ── 5. THE LOG — the FUP-T3/T7 rule: a client-triggerable branch costs no stack ─

const SERVER_LOG = process.env.SERVER_LOG
const STACK_FRAME = /^\s+at\s/m

test.describe('FUP-T14 — no stack reaches the log for any date shape', () => {
  test.skip(!SERVER_LOG, 'set SERVER_LOG=<backend log path> to exercise the log assertions')

  // ⚠ --workers=1 is a REQUIREMENT: the window reads a SHARED appended file, so a
  // parallel spec's genuine 500 would either redden this or, far worse, mask it.
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

  test('both routes × every bad date shape append zero stack frames', async () => {
    const tx = await freshTransaction('log window')
    const log = await appended(async () => {
      for (const date of ALL_BAD_DATES) {
        const post = await ctx.post('/api/transactions/payment', {
          headers: admin(),
          data: { friend_id: friendId, amount: 5, date },
        })
        expect(post.status(), `POST ${label(date)} refused cleanly`).toBe(400)
        const patch = await ctx.patch(`/api/transactions/${tx.id}`, { headers: admin(), data: { date } })
        expect(patch.status(), `PATCH ${label(date)} refused cleanly`).toBe(400)
      }
    })
    expect(log, 'no stack frames on a client-triggerable branch').not.toMatch(STACK_FRAME)
    expect(log, 'and nothing from the RangeError').not.toMatch(/Invalid time value|RangeError/i)
  })

  test('the window is not vacuous — a genuine 500 still appends a stack', async () => {
    // ⚠ Counter-assertion. Without it, a broken `appended()` (wrong path, a rotated
    // file, a server writing elsewhere) would make every assertion above pass by
    // reading an empty string. A disallowed `Origin` is the repo's standing 500.
    const log = await appended(async () => {
      const res = await ctx.get('/api/cycles', {
        headers: { Origin: 'http://not-an-allowed-origin.example' },
      })
      expect(res.status()).toBe(500)
    })
    expect(log, 'the log window really observes this server').toMatch(STACK_FRAME)
  })
})
