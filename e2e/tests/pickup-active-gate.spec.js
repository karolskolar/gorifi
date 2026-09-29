import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'

// ─────────────────────────────────────────────────────────────────────────────
// FUP-T25 — „IS THIS PICKUP POINT CHOOSABLE?" HAS EXACTLY TWO WRITERS, AND THIS
// FILE IS THE ONE THAT HOLDS THEM TO THE SAME ANSWER.
//
// `pickup_location_id` is written in exactly two places in the whole app:
//
//   1. `POST /api/orders/cycle/:cycleId/friend/:friendId/submit` — the friend's own
//      choice at submit time, and
//   2. `PATCH /api/orders/cycle/:cycleId/friend/:friendId/pickup` — the admin's
//      later correction (module 11 / the 2026-09-03 „za každých okolností" widening).
//
// Both must refuse a point that is not `active = 1`, and until FUP-T25 they said so
// in TWO PLACES: the submit route carried a byte copy of `helpers/pickup.js`
// `activeLocation()` — same statement, same refusal, same sentence — while the PATCH
// already called the helper. Nothing was broken; it was a DRIFT SURFACE, and a
// load-bearing one:
//
// ⚠ FUP-T23's claim — "no sequence of API calls can leave a party pointing at a
//   pickup row that does not exist" — rests on BOTH of these refusing an inactive
//   point. `DELETE /api/pickup-locations/:id` only ever SOFT-deletes a referenced
//   point (`pickupLocationInUse()`, both stores), so the only way a party could end
//   up on a retired row is a writer that lets them CHOOSE one. Drop `active = 1` from
//   one of the two copies and that claim silently becomes false — and the only thing
//   left standing in its place is a `DB_PATH`-gated fixture in
//   `distribution-handover.spec.js`, which self-skips without the env var.
//
// ⚠ THIS IS A DIFFERENT QUESTION FROM `pickupLocationInUse()` (FUP-T23), and the two
//   must NOT be merged into one function. That one asks "is this point REFERENCED?"
//   and is deliberately BROAD (it counts a reference in either store, effective or
//   stale, and fails CLOSED on an unbindable id, because being wrong conservatively
//   only keeps a row nobody can see). This one asks "is this point CHOOSABLE?" and is
//   deliberately NARROW (`active = 1` only, and it fails to `null` on an unbindable
//   id so the caller's own 400 answers). They move in opposite directions on every
//   axis; one function would have to be wrong for one of its two callers.
//
// ⚠ THE PROPERTY THIS FILE EXISTS FOR, and the one that did NOT exist before
//   FUP-T25: a mutation in `activeLocation()` must redden BOTH writers. That is why
//   every gate test below is generated from the same `WRITERS` table and why each
//   writer carries BOTH halves — the refusal AND the non-vacuity acceptance. Proven
//   in both directions when the row landed:
//     • drop `AND active = 1` from the helper ⇒ both writers' "refuses a
//       DEACTIVATED point" tests fail;
//     • make the helper return `null` unconditionally ⇒ both writers'
//       "an ACTIVE point is accepted and STORED" tests fail.
//   Before the refactor, either mutation reddened the PATCH alone — which is exactly
//   the hole.
//
// ⚠ THE RESPONSE SHAPES ARE NOT IDENTICAL, DELIBERATELY, and that is pinned here so
//   the shared gate cannot quietly align them: the submit answers `{ error }` with NO
//   `field` marker (it has never had one — `nonstring-body-shape.spec.js` pins the
//   sentence for every unbindable shape), while the PATCH answers `{ error, field:
//   'pickup_location_id' }` because its body has two candidate fields and the UI
//   marks the offending control. Same status, same sentence, different envelope.
// ─────────────────────────────────────────────────────────────────────────────

const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

const admin = () => ({ 'X-Admin-Token': adminToken })
const shared = () => ({ 'X-Friends-Password': FRIENDS_PASSWORD })

// ⚠ Copied VERBATIM from both handlers. If this constant has to change, the row that
// changes it is moving a shipped refusal and owes the other spec files the same edit.
const REFUSAL = 'Vybrané miesto vyzdvihnutia neexistuje alebo nie je aktívne'

// An id no `pickup_locations` row has ever had. Distinct from "deactivated", which is
// the case the `active = 1` half of the gate actually owns.
const UNKNOWN_LOCATION_ID = 999999

let cycleId = 0
let productId = 0
let activePlace = null // stays active for the whole file
let retiredPlace = null // created active, PROVED usable, then deactivated

async function adminReq(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: admin(),
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

let friendSeq = 0
/** A bare friend row — the shared password is the credential, so no setup beyond this. */
async function makeFriend(label) {
  const res = await adminReq('/api/friends', {
    method: 'post',
    data: { name: `FUP25 ${label} ${uniq}${++friendSeq}` },
  })
  expect(res.status(), `friend fixture ${label}`).toBe(201)
  return (await res.json()).id
}

async function makeLocation(label) {
  const res = await adminReq('/api/pickup-locations', {
    method: 'post',
    data: { name: `FUP25 ${label} ${uniq}`, address: 'Testovacia 25' },
  })
  expect(res.status(), `pickup location ${label}`).toBe(201)
  return res.json()
}

/** A saved cart — i.e. the `orders` row BOTH writers then work on. */
async function seedCart(friendId) {
  const res = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friendId}`, {
    headers: shared(),
    data: { items: [{ product_id: productId, variant: '250g', quantity: 1 }] },
    timeout: TIMEOUT,
  })
  expect(res.status(), 'cart seeded').toBe(200)
}

/** The STORED row, read back through the admin listing both surfaces use. */
async function storedParty(friendId) {
  const res = await adminReq(`/api/orders/cycle/${cycleId}`)
  expect(res.status(), 'admin orders listing').toBe(200)
  const row = (await res.json()).find((o) => o.friend_id === friendId)
  expect(row, `friend ${friendId} is listed in the cycle`).toBeTruthy()
  return row
}

// ── the two writers, behind one shape ────────────────────────────────────────
//
// `prepare` leaves the friend with an `orders` row and NO pickup; `write` asks the
// writer for a location id; `expectRefused` reads the row back, because a status
// assertion alone cannot see a write that happened anyway.
const WRITERS = [
  {
    name: 'POST …/submit (the friend chooses)',
    field: null, // the shipped refusal carries NO field marker
    prepare: seedCart,
    write: (friendId, pickup_location_id) =>
      ctx.post(`/api/orders/cycle/${cycleId}/friend/${friendId}/submit`, {
        headers: shared(),
        data: { pickup_location_id },
        timeout: TIMEOUT,
      }),
    async expectRefused(friendId) {
      const row = await storedParty(friendId)
      expect(row.pickup_location_id, 'the refusal stored nothing').toBeFalsy()
      expect(row.status, 'and it did not submit the order anyway').toBe('draft')
    },
  },
  {
    name: 'PATCH …/pickup (the admin corrects)',
    field: 'pickup_location_id',
    prepare: seedCart,
    write: (friendId, pickup_location_id) =>
      adminReq(`/api/orders/cycle/${cycleId}/friend/${friendId}/pickup`, {
        method: 'patch',
        data: { pickup_location_id },
      }),
    async expectRefused(friendId) {
      const row = await storedParty(friendId)
      expect(row.pickup_location_id, 'the refusal stored nothing').toBeFalsy()
    },
  },
]

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })

  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  const cycle = await adminReq('/api/cycles', {
    method: 'post',
    data: { name: `E2E FUP25 ${uniq}`, type: 'coffee', status: 'open' },
  })
  expect(cycle.status(), 'cycle fixture').toBe(201)
  cycleId = (await cycle.json()).id

  const product = await adminReq('/api/products', {
    method: 'post',
    data: { cycle_id: cycleId, name: `FUP25 káva ${uniq}`, purpose: 'Espresso', price_250g: 9.5 },
  })
  expect(product.status(), 'product fixture').toBe(201)
  productId = (await product.json()).id

  activePlace = await makeLocation('Aktivne')
  retiredPlace = await makeLocation('Zrusene')

  // ⚠ RETIRED THROUGH THE ADMIN PATCH, DELIBERATELY — i.e. through NEITHER of the two
  // writers this file is about. An earlier draft built this state by submitting an
  // order with the point and then letting FUP-T23's soft-delete retire it, which was
  // a prettier fixture and a WORSE test: it made `beforeAll` depend on the very gate
  // under test, so a mutation that refused every point killed the fixture and the
  // whole file reported ONE failure with 16 „did not run" — the two writers' halves
  // never ran, and the mutation proof could not tell them apart. That lifecycle is
  // still pinned, as a TEST of its own, at the bottom of this file.
  const retire = await adminReq(`/api/pickup-locations/${retiredPlace.id}`, {
    method: 'patch',
    data: { active: false },
  })
  expect(retire.status(), 'retiring the point').toBe(200)
  expect((await retire.json()).active, 'the fixture really is inactive').toBeFalsy()
})

test.afterAll(async () => {
  await ctx?.dispose()
})

// ═══════════════════════════════════════════════════════════════════════════
// Both writers, the same gate, the same sentence.

for (const writer of WRITERS) {
  test.describe(`${writer.name} — the active-point gate`, () => {
    test('refuses a DEACTIVATED point, with the shipped status and sentence', async () => {
      const friendId = await makeFriend('Zrus')
      await writer.prepare(friendId)

      const res = await writer.write(friendId, retiredPlace.id)
      expect(res.status(), 'a retired point is a 400, not a 500 and not a 200').toBe(400)
      const body = await res.json()
      expect(body.error, 'the shipped sentence, byte for byte').toBe(REFUSAL)
      await writer.expectRefused(friendId)
    })

    test('refuses an id no pickup row has ever had', async () => {
      const friendId = await makeFriend('Neznam')
      await writer.prepare(friendId)

      const res = await writer.write(friendId, UNKNOWN_LOCATION_ID)
      expect(res.status()).toBe(400)
      expect((await res.json()).error).toBe(REFUSAL)
      await writer.expectRefused(friendId)
    })

    // ⚠ THE NON-VACUITY HALF, and the one that catches a mutation in the OTHER
    // direction: a helper that answers `null` for everything would pass both refusal
    // tests above and fail here.
    test('NOTHING TIGHTENED: an ACTIVE point is accepted and STORED', async () => {
      const friendId = await makeFriend('Aktiv')
      await writer.prepare(friendId)

      const res = await writer.write(friendId, activePlace.id)
      expect(res.status(), 'an active point is the happy path').toBe(200)
      expect((await storedParty(friendId)).pickup_location_id, 'and it really lands in the column')
        .toBe(activePlace.id)
    })

    // The FUP-T13 class, asked of BOTH writers rather than of one: an unbindable id
    // must reach the route's own 400, never the binder. `[id]` is the trap — a
    // one-element array SPREADS to exactly the one slot the statement wants, so it is
    // the shape that gets silently ACCEPTED when the guard is missing.
    for (const [label, value] of [
      ['an object', {}],
      ['a boolean', true],
      ['a ONE-ELEMENT array', 'ONE_ELEMENT_ARRAY'],
      ['a NaN-ish string', 'abc'],
    ]) {
      test(`400 for ${label}, never a server fault`, async () => {
        const friendId = await makeFriend('Tvar')
        await writer.prepare(friendId)

        const sent = value === 'ONE_ELEMENT_ARRAY' ? [activePlace.id] : value
        const res = await writer.write(friendId, sent)
        expect(res.status(), `${label} must not reach the binder`).toBe(400)
        expect((await res.json()).error).toBe(REFUSAL)
        await writer.expectRefused(friendId)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// The envelopes differ, and they must keep differing.

test.describe('the two refusals share a sentence, not an envelope', () => {
  test('the submit answers { error } alone — no field marker, as shipped', async () => {
    const friendId = await makeFriend('Oba1')
    await seedCart(friendId)

    const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friendId}/submit`, {
      headers: shared(),
      data: { pickup_location_id: retiredPlace.id },
      timeout: TIMEOUT,
    })
    expect(res.status()).toBe(400)
    expect(Object.keys(await res.json()).sort(), 'the submit has never carried a field marker')
      .toEqual(['error'])
  })

  test('the PATCH answers { error, field: pickup_location_id }', async () => {
    const friendId = await makeFriend('Oba2')
    await seedCart(friendId)

    const res = await adminReq(`/api/orders/cycle/${cycleId}/friend/${friendId}/pickup`, {
      method: 'patch',
      data: { pickup_location_id: retiredPlace.id },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['error', 'field'])
    expect(body.field).toBe('pickup_location_id')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The lifecycle the two rows meet in: FUP-T23 retires a point INSTEAD of deleting it
// when somebody already uses it, and FUP-T25 is what stops anybody choosing it after.

test.describe('a point retired under a live reference (FUP-T23) stops being choosable', () => {
  test('usable today, soft-deleted because it is referenced, refused tomorrow', async () => {
    const place = await makeLocation('Zivotny cyklus')

    // 1. It is a perfectly good point TODAY. This is the non-vacuity of every
    //    "deactivated" assertion in this file: without it, a route that refused
    //    EVERY id would satisfy them all.
    const early = await makeFriend('Skor')
    await seedCart(early)
    const accepted = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${early}/submit`, {
      headers: shared(),
      data: { pickup_location_id: place.id },
      timeout: TIMEOUT,
    })
    expect(accepted.status(), 'an active point submits').toBe(200)
    expect((await accepted.json()).order.pickup_location_id).toBe(place.id)

    // 2. It is now REFERENCED, so the DELETE deactivates instead of destroying
    //    (FUP-T23 — `pickupLocationInUse()`, both stores). The row survives, and it
    //    keeps naming itself on the party that already chose it.
    expect((await adminReq(`/api/pickup-locations/${place.id}`, { method: 'delete' })).status()).toBe(204)
    const all = await adminReq('/api/pickup-locations/all')
    expect(all.status()).toBe(200)
    const row = (await all.json()).find((l) => l.id === place.id)
    expect(row, 'the row SURVIVES the delete — somebody is pointing at it').toBeTruthy()
    expect(row.active, 'it is inactive, not gone').toBeFalsy()
    expect((await storedParty(early)).pickup_location_name, 'and it still labels the party that chose it')
      .toBe(place.name)

    // 3. ⚠ AND NOBODY MAY CHOOSE IT ANY MORE — through EITHER writer. This is the
    //    half FUP-T25 makes one statement instead of two: the soft-delete is only a
    //    safe answer because no writer can hand the retired id back out.
    const late = await makeFriend('Neskor')
    await seedCart(late)
    const viaSubmit = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${late}/submit`, {
      headers: shared(),
      data: { pickup_location_id: place.id },
      timeout: TIMEOUT,
    })
    expect(viaSubmit.status(), 'the friend may not choose a retired point').toBe(400)
    expect((await viaSubmit.json()).error).toBe(REFUSAL)

    const viaPatch = await adminReq(`/api/orders/cycle/${cycleId}/friend/${late}/pickup`, {
      method: 'patch',
      data: { pickup_location_id: place.id },
    })
    expect(viaPatch.status(), 'nor may the admin move anybody onto one').toBe(400)
    expect((await viaPatch.json()).error).toBe(REFUSAL)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The one home, stated as the grep FUP-T25's acceptance names.

test.describe('one home', () => {
  test('the active-point statement appears exactly once in the backend', async () => {
    // The refusal above is behaviour; this is the structural half of the same claim,
    // and it is what keeps the two writers reddening TOGETHER. A second copy of the
    // statement passes every behavioural test in this file on the day it is written
    // and drifts on some later one.
    const { execFileSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/src')

    let hits = ''
    try {
      hits = execFileSync(
        'grep',
        ['-rn', "pickup_locations WHERE id = ? AND active = 1", backend],
        { encoding: 'utf8' },
      )
    } catch (err) {
      // grep exits 1 on no match — which would mean the gate vanished entirely.
      hits = err.stdout || ''
    }

    const lines = hits.split('\n').filter(Boolean)
    expect(lines.length, `expected ONE home, found:\n${hits}`).toBe(1)
    expect(lines[0], 'and that home is helpers/pickup.js').toMatch(/helpers[/\\]pickup\.js/)
  })
})
