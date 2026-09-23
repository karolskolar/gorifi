import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
// CS-T4: the ONE home of the rendered-copy sweep (`e2e/helpers/copy-sweep.js`) —
// visible text plus the attributes that render as copy, with every
// `[data-user-copy]` subtree dropped.
import { collectAppCopy } from '../helpers/copy-sweep.js'
import { makeAdmin } from '../helpers/admin.js'
// PI-T11: the vocabulary ban has ONE home now (`e2e/helpers/vocabulary.js`). It was
// module-scoped here, never exported, while §UC-PI-017 carried a THIRD spelling — see
// that file's header for the three-way diff and why the union is what it is.
import { BANNED } from '../helpers/vocabulary.js'

// CS-T1 — module 17 (cycle stages), 17 §UC-CS-001 / §UC-CS-002 / §UC-CS-003 /
// §UC-CS-004. The BACKEND half of the stage model: three columns on
// `order_cycles`, the `POST`/`PATCH /cycles` contract over them, the ONE automatic
// transition (`markCycleReady()`), and the four payloads that publish them.
// The lib, the component and the two UI surfaces are CS-T2/T3/T4.
//
// What carries this file, in the order of how badly each one bites:
//
//  1. ⚠ **EVERY REFUSAL READS THE ROW BACK.** A 400 or a 409 here must leave the
//     row BYTE-IDENTICAL, and a status assertion cannot see a route that refused
//     the request *after* writing half of it — or one that answered 400 while
//     `bindValue` quietly NULLed the column (the FUP-T13 lesson: assert the value
//     read back, never merely the status).
//
//  2. ⚠ **`stage` NEVER REACHES THE CHECK CONSTRAINT.** `db/schema.js` carries
//     `CHECK (stage IN ('ordered','arrived','ready'))`, and a
//     `SQLITE_CONSTRAINT_CHECK` throw is a **500** plus a stack in the log. So the
//     route validates first, and the non-string shapes (`{}`, `true`, `[1]`,
//     `null`) are asserted to land on the same 400 as `'packed'` — the FUP-T13
//     one-element-array trap included.
//
//  3. **The seam runs LIVE.** DP-T3/DP-T4 already call `markCycleReady()` inside
//     their hand-over transactions, so §UC-CS-009 item 3 drives the real
//     `PATCH …/handed-over` routes rather than the helper. It needs no self-skip:
//     module 16 is merged. The three shipped `cycle_stage` assertions in
//     `distribution-handover.spec.js` are NOT this evidence — every cycle in that
//     file is `open`, where the helper is a no-op by design.
//
//  4. ⚠ ~~**A LOCKED CYCLE WITH `stage IS NULL` IS UNREACHABLE THROUGH THE API**~~
//     — **SUPERSEDED by FUP-T26 (2026-09-20):** the lock default now fires from
//     `open` only, so `PATCH { status: 'locked' }` on a PLANNED cycle reaches
//     exactly this row (pinned in the FUP-T26 describe). The paragraph's reasoning
//     below is otherwise unchanged, and so is the test it explains — a
//     manufactured row is still the honest way to pin the PRE-MODULE state.
//     Locking from `open` writes `ordered`, unlocking writes NULL *and* opens the
//     cycle, and the PATCH refuses `stage: null`. But it is the state EVERY locked cycle in
//     production is in right now (§UC-CS-001 forbids a backfill), and it is the
//     exact row the stub's superseded contract (`stage IN ('ordered','arrived')`)
//     would have left stuck at NULL forever. So that one test manufactures the row
//     with `node:sqlite` and self-skips without `DB_PATH` — the
//     BUILD-THE-SCENARIO kind of gate, not an extra-assertion one.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const DB_PATH = process.env.DB_PATH || ''
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

// FUP-T27 — ONE home for the admin request path: it re-authenticates ONCE on a
// 401 instead of trusting a token the next `POST /api/admin/login` anywhere in the
// suite silently rotates out. See `helpers/admin.js`.
const admin = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
  timeout: TIMEOUT,
})

/** The PATCH under test, with a RAW body — the shapes a typed helper cannot express. */
async function patchCycle(cycleId, raw) {
  return ctx.patch(`/api/cycles/${cycleId}`, {
    headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' },
    data: raw,
    timeout: TIMEOUT,
  })
}

/** The admin's own read-back — the row as stored, `SELECT *`. */
async function readCycle(cycleId) {
  const res = await admin(`/api/cycles/${cycleId}`)
  expect(res.status(), 'cycle read-back').toBe(200)
  return res.json()
}

/** The three fields under test, as one comparable object. */
const stageTriple = (row) => ({ opens_at: row.opens_at, closes_at: row.closes_at, stage: row.stage })

async function makeCycle(label, over = {}) {
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name: `E2E CS1 ${label} ${uniq}`, type: 'coffee', status: 'open', ...over },
  })
  expect(res.status(), 'cycle create').toBe(201)
  return res.json()
}

async function addProduct(cycleId) {
  const res = await admin('/api/products', {
    method: 'post',
    data: {
      cycle_id: cycleId, name: `CS1 Kava ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé',
      price_250g: 10, price_1kg: 30,
    },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `cs1_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `CS1 ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: null } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token
  return { id: row.id, name, auth: { Authorization: `Bearer ${token}` } }
}

async function ownOrder(friend, cycleId, items) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, {
    headers: friend.auth, data: { items }, timeout: TIMEOUT,
  })
  expect(put.status(), 'cart PUT').toBe(200)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, {
    headers: friend.auth, data: { pickup_location_note: 'U mna doma' }, timeout: TIMEOUT,
  })
  expect(res.status(), 'submit').toBe(200)
  return (await res.json()).order
}

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth, timeout: TIMEOUT })
  expect([200, 201], 'share link').toContain(res.status())
  return (await res.json()).link
}

async function submitGuest(linkToken, name, phone, items) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, {
    data: { guest_name: name, guest_phone: phone, items },
    timeout: TIMEOUT,
  })
  expect(res.status(), 'guest submit').toBe(201)
  return (await res.json()).order
}

async function distribution(cycleId) {
  const res = await admin(`/api/cycles/${cycleId}/distribution`)
  expect(res.status(), 'distribution').toBe(200)
  return res.json()
}

/** Pack a party's own items + whole order, and every one of its guest bags. */
async function packParty(cycleId, friendId, orderId) {
  const body = await distribution(cycleId)
  const party = body.distribution.find((p) => p.id === friendId)
  expect(party, 'party is on the board').toBeTruthy()
  for (const item of party.items) {
    if (item.packed) continue
    expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  }
  for (const guest of party.guest_orders || []) {
    for (const item of guest.items) {
      if (item.packed) continue
      expect((await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
    }
  }
  if (orderId) {
    expect((await admin(`/api/orders/${orderId}/packed`, { method: 'patch' })).status()).toBe(200)
  }
}

/** The API-level ledger claim, which needs no DB_PATH at all. */
async function ledgerSnapshot(friendId) {
  const res = await admin(`/api/friends/${friendId}/detail`)
  expect(res.status(), 'friend detail').toBe(200)
  const body = await res.json()
  return { count: (body.transactions || []).length, balance: body.balance }
}

function withDb(fn) {
  if (!DB_PATH) return null
  let db
  try {
    db = new DatabaseSync(DB_PATH)
  } catch {
    return null
  }
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
  expect(adminToken).toBeTruthy()
})

test.afterAll(async () => { await ctx?.dispose() })

// ─────────────────────────────────────────────────────────────────────────────
// 1. §UC-CS-001 — the three columns exist and the enum is enforced at storage
// ─────────────────────────────────────────────────────────────────────────────
test.describe('CS-T1 · 17 §UC-CS-001 — the columns', () => {
  test('a freshly created cycle carries all three, all NULL', async () => {
    const cycle = await makeCycle('Schema')
    for (const key of ['opens_at', 'closes_at', 'stage']) {
      expect(Object.prototype.hasOwnProperty.call(cycle, key), `POST response carries ${key}`).toBe(true)
      expect(cycle[key], `${key} defaults to NULL`).toBe(null)
    }
    expect(stageTriple(await readCycle(cycle.id))).toEqual({ opens_at: null, closes_at: null, stage: null })
  })

  // ⚠ THE PLACEMENT TRAP, and the reason §UC-CS-001 spells it out. `schema.js` has a
  // `_check_test` block that RECREATES `order_cycles` from a HARD-CODED column list
  // plus an `INSERT ... SELECT` naming the old columns — it fires on any database
  // whose `status` CHECK still rejects 'planned'. An `ADD COLUMN` placed BEFORE that
  // block is silently DROPPED on exactly those databases, and no API test can see it
  // because no API can produce a pre-'planned' schema. So this test builds one and
  // runs the real migration against it in a child process.
  //
  // ⚠ Mutation-proved in both directions (CS-T1): moving the three ALTERs above the
  // recreate block makes THIS test red while every other test in the suite stays
  // green — it is the only assertion that covers the trap.
  test('the three columns SURVIVE the `_check_test` recreate on a pre-\'planned\' database', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const schemaPath = resolve(here, '../../backend/src/db/schema.js')
    test.skip(!existsSync(schemaPath), 'backend source is not beside e2e/ (running against a deployment)')

    const dbPath = join(tmpdir(), `gorifi-cs1-oldschema-${uniq}.sqlite`)
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })

    // The PRE-'planned' table — the shape the recreate block exists for.
    //
    // ⚠ RECORDED, NOT FIXED (found while writing this test, CS-T1): the fixture has
    // to carry `type` even though a genuinely old database would not, because the
    // recreate block's `INSERT ... SELECT` NAMES `type` while the ALTER that adds it
    // lives ~430 lines LATER (schema.js, `ADD COLUMN type`). On a database old
    // enough to trip the CHECK and therefore old enough to lack `type`, the block
    // throws `no such column: type` from inside a `catch` with no inner try — i.e.
    // the backend crashes at boot. That is a pre-existing defect of the SAME family
    // as the recorded `parcel_enabled`/`parcel_fee` omission and is explicitly out
    // of module 17's scope (§UC-CS-001: „recorded so nobody fixes it inside this
    // row"). It does not weaken what this test proves: with `type` present the block
    // runs exactly as designed, and that is when the placement rule bites.
    const seedDb = new DatabaseSync(dbPath)
    seedDb.exec(`
      CREATE TABLE order_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'open' CHECK (status IN ('open', 'locked', 'completed')),
        shared_password TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        type TEXT DEFAULT 'coffee'
      )
    `)
    seedDb.prepare("INSERT INTO order_cycles (name, status) VALUES ('CS1 stary cyklus', 'locked')").run()
    seedDb.close()

    // ⚠ NON-VACUITY: prove the recreate block actually FIRES here, or this test
    // would pass against any schema at all.
    const probe = new DatabaseSync(dbPath)
    let rejected = false
    try {
      probe.prepare("INSERT INTO order_cycles (name, status) VALUES ('_probe', 'planned')").run()
    } catch {
      rejected = true
    }
    probe.close()
    expect(rejected, "the fixture's CHECK really does reject 'planned'").toBe(true)

    execFileSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(schemaPath).href)})`], {
      env: { ...process.env, DB_PATH: dbPath },
      stdio: 'pipe',
      timeout: TIMEOUT,
    })

    const after = new DatabaseSync(dbPath, { readOnly: true })
    const columns = after.prepare('PRAGMA table_info(order_cycles)').all().map((c) => c.name)
    const rows = after.prepare('SELECT name, status, stage FROM order_cycles').all()
    after.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })

    expect(columns, 'the recreate ran — `planned` is in the CHECK now').toContain('type')
    for (const key of ['opens_at', 'closes_at', 'stage']) {
      expect(columns, `${key} survived the recreate`).toContain(key)
    }
    expect(rows.map((r) => r.name), 'the existing row came through the recreate').toContain('CS1 stary cyklus')
    expect(rows.find((r) => r.name === 'CS1 stary cyklus').stage, 'NO BACKFILL — a pre-module locked cycle stays NULL').toBe(null)
  })

  test('the CHECK constraint rejects a fourth stage value at the SQLite layer', async () => {
    test.skip(!DB_PATH, 'needs DB_PATH: the route refuses `packed` long before SQLite sees it')
    const cycle = await makeCycle('Check')
    const threw = withDb((db) => {
      try {
        db.prepare('UPDATE order_cycles SET stage = ? WHERE id = ?').run('packed', cycle.id)
        return null
      } catch (err) {
        return String(err && err.message)
      }
    })
    expect(threw, 'a direct write of an unknown stage is refused by the constraint').toBeTruthy()
    expect(stageTriple(await readCycle(cycle.id)).stage, 'nothing was stored').toBe(null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. §UC-CS-002 — POST /cycles
// ─────────────────────────────────────────────────────────────────────────────
test.describe('CS-T1 · 17 §UC-CS-002 — POST /api/cycles', () => {
  test('stores both dates', async () => {
    const cycle = await makeCycle('PostDates', { status: 'planned', opens_at: '2026-10-03', closes_at: '2026-10-10' })
    expect(stageTriple(cycle)).toEqual({ opens_at: '2026-10-03', closes_at: '2026-10-10', stage: null })
    expect(stageTriple(await readCycle(cycle.id))).toEqual({ opens_at: '2026-10-03', closes_at: '2026-10-10', stage: null })
  })

  test('an impossible calendar date is 400 and creates NOTHING', async () => {
    const before = (await admin('/api/cycles')).json()
    const name = `E2E CS1 PostBad ${uniq}`
    const res = await ctx.post('/api/cycles', {
      headers: { 'X-Admin-Token': adminToken },
      data: { name, type: 'coffee', closes_at: '2026-13-40' },
      timeout: TIMEOUT,
    })
    expect(res.status()).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Neplatný dátum', field: 'closes_at' })

    // ⚠ NON-VACUITY: the refusal must not be "this route creates nothing".
    const list = await (await admin('/api/cycles')).json()
    expect(list.some((c) => c.name === name), 'no cycle was created').toBe(false)
    expect((await before).length, 'the list itself is readable').toBeGreaterThan(0)
  })

  test('a deadline before the opening is 400 `dates_order`', async () => {
    const res = await ctx.post('/api/cycles', {
      headers: { 'X-Admin-Token': adminToken },
      data: { name: `E2E CS1 PostOrder ${uniq}`, opens_at: '2026-10-10', closes_at: '2026-10-03' },
      timeout: TIMEOUT,
    })
    expect(res.status()).toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'dates_order' })
  })

  test('`stage` in a CREATE body is IGNORED, never stored and never a 400', async () => {
    const cycle = await makeCycle('PostStage', { stage: 'ready' })
    expect(cycle.status, 'a new cycle is open').toBe('open')
    expect(stageTriple(await readCycle(cycle.id)).stage, 'stage is meaningless on a non-locked cycle').toBe(null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. §UC-CS-002 — PATCH /cycles/:id, the dates
// ─────────────────────────────────────────────────────────────────────────────
test.describe('CS-T1 · 17 §UC-CS-002 — PATCH dates', () => {
  test('both dates are writable on a PLANNED cycle and read back', async () => {
    const cycle = await makeCycle('PatchPlanned', { status: 'planned' })
    const res = await patchCycle(cycle.id, { opens_at: '2026-10-03' })
    expect(res.status()).toBe(200)
    expect((await res.json()).opens_at, 'the PATCH response is the full row').toBe('2026-10-03')
    expect(stageTriple(await readCycle(cycle.id)).opens_at).toBe('2026-10-03')
  })

  test('the deadline is writable while the cycle is OPEN, and on a LOCKED one', async () => {
    const cycle = await makeCycle('PatchOpen')
    expect((await patchCycle(cycle.id, { closes_at: '2026-11-02' })).status()).toBe(200)
    expect((await readCycle(cycle.id)).closes_at).toBe('2026-11-02')

    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { closes_at: '2026-11-04' })).status()).toBe(200)
    const after = await readCycle(cycle.id)
    expect(after.closes_at, 'corrections after the lock are allowed').toBe('2026-11-04')
    expect(after.stage, 'a date edit does not disturb the stage').toBe('ordered')
  })

  test('`null` and `\'\'` CLEAR the column', async () => {
    const cycle = await makeCycle('PatchClear', { opens_at: '2026-10-03', closes_at: '2026-10-10' })
    expect((await patchCycle(cycle.id, { opens_at: null })).status()).toBe(200)
    expect((await readCycle(cycle.id)).opens_at).toBe(null)
    expect((await patchCycle(cycle.id, { closes_at: '' })).status()).toBe(200)
    expect((await readCycle(cycle.id)).closes_at).toBe(null)
  })

  const BAD_DATES = ['2026-13-40', '2026-02-30', '03.10.2026', '2026-10-3', '2026-10-03T00:00:00Z', 'zajtra']
  for (const bad of BAD_DATES) {
    test(`\`${bad}\` is 400 Neplatný dátum and the stored value SURVIVES`, async () => {
      const cycle = await makeCycle(`PatchBad${BAD_DATES.indexOf(bad)}`, { opens_at: '2026-10-03' })
      const res = await patchCycle(cycle.id, { opens_at: bad })
      expect(res.status()).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'Neplatný dátum', field: 'opens_at' })
      expect((await readCycle(cycle.id)).opens_at, 'byte-identical after the refusal').toBe('2026-10-03')
    })
  }

  test('a deadline before the opening is 400 `dates_order`, and NEITHER date moves', async () => {
    const cycle = await makeCycle('PatchOrder', { opens_at: '2026-10-03', closes_at: '2026-10-10' })
    const res = await patchCycle(cycle.id, { opens_at: '2026-10-20', closes_at: '2026-10-11' })
    expect(res.status()).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Uzávierka nemôže byť pred otvorením', reason: 'dates_order' })
    expect(stageTriple(await readCycle(cycle.id)))
      .toEqual({ opens_at: '2026-10-03', closes_at: '2026-10-10', stage: null })
  })

  test('the order check reads the row AS IT WOULD BE — a lone deadline edit is refused too', async () => {
    const cycle = await makeCycle('PatchOrderStored', { opens_at: '2026-10-10' })
    const res = await patchCycle(cycle.id, { closes_at: '2026-10-03' })
    expect(res.status(), 'the stored opens_at is part of the comparison').toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'dates_order' })
    expect((await readCycle(cycle.id)).closes_at).toBe(null)

    // ⚠ NON-VACUITY: the same edit one day later must PASS, or this test would
    // also be green for a route that refused every `closes_at`.
    expect((await patchCycle(cycle.id, { closes_at: '2026-10-10' })).status()).toBe(200)
    expect((await readCycle(cycle.id)).closes_at).toBe('2026-10-10')
  })

  test('equal dates are allowed (open and close on the same day)', async () => {
    const cycle = await makeCycle('PatchSameDay')
    expect((await patchCycle(cycle.id, { opens_at: '2026-10-03', closes_at: '2026-10-03' })).status()).toBe(200)
  })

  test('clearing the opening frees a deadline that used to precede it', async () => {
    const cycle = await makeCycle('PatchClearThenEarlier', { opens_at: '2026-10-10' })
    expect((await patchCycle(cycle.id, { opens_at: null, closes_at: '2026-10-03' })).status()).toBe(200)
    expect(stageTriple(await readCycle(cycle.id)))
      .toEqual({ opens_at: null, closes_at: '2026-10-03', stage: null })
  })

  // FUP-T13: an UNBINDABLE shape is "absent", never a wipe and never a 500.
  // ⚠ 3.5 is NOT in this list: `bindValue` PASSES a finite number, so it reaches
  // the date check and is a 400 — pinned in its own test below.
  for (const shape of [{}, true, [1], []]) {
    test(`an unbindable opens_at (${JSON.stringify(shape)}) answers 200 and leaves the value UNCHANGED`, async () => {
      const cycle = await makeCycle(`PatchShape${JSON.stringify(shape).replace(/\W/g, '')}`, { opens_at: '2026-10-03' })
      const res = await patchCycle(cycle.id, { opens_at: shape })
      expect(res.status(), 'never a 400 and never a 500 — the shipped FUP-T13 skip').toBe(200)
      expect((await readCycle(cycle.id)).opens_at, 'the stored value survives').toBe('2026-10-03')
    })
  }

  test('a NUMBER is refused rather than stored — `20261003` is not a date', async () => {
    // ⚠ `bindValue` PASSES a finite number (SQLite can bind it), so the format
    // check is the only thing between `20261003` and the column.
    const cycle = await makeCycle('PatchNumber')
    const res = await patchCycle(cycle.id, { closes_at: 20261003 })
    expect(res.status()).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Neplatný dátum', field: 'closes_at' })
    expect((await readCycle(cycle.id)).closes_at).toBe(null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. §UC-CS-002 — PATCH /cycles/:id, the stage and its coupling to the status
// ─────────────────────────────────────────────────────────────────────────────
test.describe('CS-T1 · 17 §UC-CS-002 — PATCH stage', () => {
  test('lock ⇒ `ordered`, unlock ⇒ NULL, and the client sends exactly what it sends today', async () => {
    const cycle = await makeCycle('Coupling')
    expect((await readCycle(cycle.id)).stage).toBe(null)

    const locked = await patchCycle(cycle.id, { status: 'locked' })
    expect(locked.status()).toBe(200)
    const lockedRow = await locked.json()
    expect(lockedRow.status).toBe('locked')
    expect(lockedRow.stage, 'LOCKED_STAGE_DEFAULT, written in the SAME update').toBe('ordered')

    const unlocked = await patchCycle(cycle.id, { status: 'open' })
    expect(unlocked.status()).toBe(200)
    expect((await unlocked.json()).stage, 'stage is meaningless off `locked`').toBe(null)
  })

  test('re-locking an ALREADY locked cycle does not reset the stage', async () => {
    const cycle = await makeCycle('Relock')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { stage: 'ready' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await readCycle(cycle.id)).stage, 'no stage change without an explicit one').toBe('ready')
  })

  test('all three values are accepted while locked — INCLUDING backwards', async () => {
    const cycle = await makeCycle('AllThree')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    for (const stage of ['arrived', 'ready', 'arrived', 'ordered']) {
      const res = await patchCycle(cycle.id, { stage })
      expect(res.status(), `stage ${stage}`).toBe(200)
      expect((await res.json()).stage).toBe(stage)
      expect((await readCycle(cycle.id)).stage).toBe(stage)
    }
  })

  test('a stage on an OPEN cycle is 409 `not_locked`, and `stage IS NULL` after', async () => {
    const cycle = await makeCycle('StageOpen')
    const res = await patchCycle(cycle.id, { stage: 'arrived' })
    expect(res.status()).toBe(409)
    expect(await res.json()).toMatchObject({
      error: 'Fázu možno meniť len pri uzamknutom cykle', reason: 'not_locked',
    })
    const after = await readCycle(cycle.id)
    expect(after.stage).toBe(null)
    expect(after.status, 'the status did not move either').toBe('open')
  })

  test('a stage on a COMPLETED cycle is 409 too, and the historical value survives', async () => {
    const cycle = await makeCycle('StageCompleted')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { stage: 'ready' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { status: 'completed' })).status()).toBe(200)

    const after = await readCycle(cycle.id)
    expect(after.status).toBe('completed')
    expect(after.stage, '⚠ completion leaves the stage ALONE — it is where the coffee ended').toBe('ready')

    const res = await patchCycle(cycle.id, { stage: 'arrived' })
    expect(res.status()).toBe(409)
    expect((await readCycle(cycle.id)).stage).toBe('ready')
  })

  test('⚠ `{ status: \'open\', stage: \'arrived\' }` on a locked cycle is the 409 — and the UNLOCK does not happen either', async () => {
    const cycle = await makeCycle('UnlockWithStage')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)

    const res = await patchCycle(cycle.id, { status: 'open', stage: 'arrived' })
    expect(res.status(), 'the effective status is checked FIRST').toBe(409)
    const after = await readCycle(cycle.id)
    expect(after.status, 'nothing was written').toBe('locked')
    expect(after.stage).toBe('ordered')
  })

  test('`{ status: \'locked\', stage: \'ready\' }` locks straight into the named stage', async () => {
    const cycle = await makeCycle('LockIntoStage')
    const res = await patchCycle(cycle.id, { status: 'locked', stage: 'ready' })
    expect(res.status(), 'the effective status is this body\'s').toBe(200)
    const row = await res.json()
    expect(row.status).toBe('locked')
    expect(row.stage, 'body.stage ?? LOCKED_STAGE_DEFAULT').toBe('ready')
  })

  // ⚠ THE CHECK CONSTRAINT MUST NEVER BE REACHED. Every one of these is a 400,
  // and a 500 here would also mean a stack per hit in the server log.
  for (const bad of ['packed', 'READY', '', 'ordered ', 'planned']) {
    test(`stage \`${JSON.stringify(bad)}\` is 400 Neplatná fáza, never a 500`, async () => {
      const cycle = await makeCycle(`BadStage${bad.replace(/\W/g, '') || 'empty'}`)
      expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
      const res = await patchCycle(cycle.id, { stage: bad })
      expect(res.status()).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'Neplatná fáza' })
      expect((await readCycle(cycle.id)).stage, 'the stored stage survives').toBe('ordered')
    })
  }

  // The FUP-T13 shape matrix, on a field that is NOT read through `bindValue` —
  // ⚠ the one-element array is the trap: `['ready']` must not be unwrapped.
  for (const shape of [{}, true, [1], ['ready'], [], 3, null]) {
    test(`a non-string stage (${JSON.stringify(shape)}) is 400, never 500 and never stored`, async () => {
      const cycle = await makeCycle(`StageShape${JSON.stringify(shape).replace(/\W/g, '') || 'empty'}`)
      expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
      const res = await patchCycle(cycle.id, { stage: shape })
      expect(res.status()).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'Neplatná fáza' })
      expect((await readCycle(cycle.id)).stage).toBe('ordered')
    })
  }

  test('an anonymous PATCH is 401 and writes nothing', async () => {
    const cycle = await makeCycle('AnonPatch')
    const res = await ctx.patch(`/api/cycles/${cycle.id}`, { data: { stage: 'arrived' }, timeout: TIMEOUT })
    expect(res.status()).toBe(401)
    expect((await readCycle(cycle.id)).stage).toBe(null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4b. FUP-T26 · 17 §UC-CS-002 — WHICH transitions may write `stage`
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ WHY THIS SECTION EXISTS AT ALL. CS-T1 measured three transitions that leave
// `order_cycles.stage` disagreeing with `status` (docs/learnings/09-cycle-stages.md
// §10) and NOTHING pinned any of them SERVER-side — the only defence was
// `lib/cycle-stages.js stageIndex()` reading `status` before `stage`, i.e. the
// frontend masking the backend. A rendered-step assertion therefore cannot be this
// evidence: it passes with the defect present. Every test below drives the real
// `PATCH /api/cycles/:id` and reads the ROW back.
//
// ⚠ AND EVERY FIXTURE IS BUILT TO NOT BE A FIXED POINT. The whole class of defect
// here is „the route wrote `ordered` when it should have written nothing", so a
// fixture whose stage already IS `ordered` proves nothing whatever the branch does.
// Each one below starts from a stage that DIFFERS from `LOCKED_STAGE_DEFAULT` and
// asserts that difference as a precondition — and the outcome assertions say both
// what the value is and what it must not be.
//
// What §UC-CS-002's table actually authorises, read as its own parentheticals scope
// it: a lock default „(transition INTO locked from `open`)"; a stage clear on
// „`status: 'open'` WHILE THE CYCLE IS `locked`"; `completed` ⇒ untouched;
// `locked → locked` ⇒ untouched without an explicit `body.stage`; `planned` ⇒
// „unchanged from today (no stage semantics)". So:
//
//   • C `completed → locked` — the shipped guard (`cycle.status !== 'locked'`) was
//     WIDER than the only rule that authorises the write. FIXED here.
//   • A `locked(ready) → planned` and B `completed(ready) → open` — conformant with
//     the table as written; LEFT ALONE, and pinned as deliberate below so the next
//     row can tell „looked at and left" from „nobody looked".
test.describe('FUP-T26 · 17 §UC-CS-002 — the lock default fires from `open` ONLY', () => {
  // `LOCKED_STAGE_DEFAULT`, re-typed rather than imported: `helpers/cycle-stage.js`
  // pulls in the backend's db handle, which an e2e worker must never open.
  const LOCK_DEFAULT = 'ordered'

  /** A round that ran to the end and carries `stage` as its historical record. */
  async function completedWithStage(label, stage) {
    expect(stage, 'a fixture equal to the default would be a FIXED POINT').not.toBe(LOCK_DEFAULT)
    const cycle = await makeCycle(label)
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { stage })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { status: 'completed' })).status()).toBe(200)
    const row = await readCycle(cycle.id)
    expect(row.status, 'fixture precondition: completed').toBe('completed')
    expect(row.stage, 'fixture precondition: the stage the coffee ended at').toBe(stage)
    return cycle
  }

  test('⚠ C — re-locking a COMPLETED round KEEPS its stage; it never rewinds to `ordered`', async () => {
    // The admin's recovery path for a mis-completed round. Before FUP-T26 this
    // answered 200 with `stage: 'ordered'`, i.e. the friend-facing timeline of a
    // round whose coffee is already handed out walked back from step 5
    // („Zabalené, rozvážame") to step 2 („Objednávky uzavreté…").
    const cycle = await completedWithStage('ReLockCompleted', 'ready')

    const res = await patchCycle(cycle.id, { status: 'locked' })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.status, 'the recovery itself still works').toBe('locked')
    expect(body.stage, 'the PATCH response carries it too').toBe('ready')

    const after = await readCycle(cycle.id)
    expect(after.status).toBe('locked')
    expect(after.stage, 'the coffee did not un-leave the admin\'s hands').toBe('ready')
    expect(after.stage, '⚠ the defect: the lock default fired from `completed`').not.toBe(LOCK_DEFAULT)
  })

  test('⚠ C is not a `ready`-only rule — an `arrived` round survives the same re-lock', async () => {
    const cycle = await completedWithStage('ReLockArrived', 'arrived')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    const after = await readCycle(cycle.id)
    expect(after.status).toBe('locked')
    expect(after.stage, 'whatever the history was, it is not overwritten').toBe('arrived')
    expect(after.stage).not.toBe(LOCK_DEFAULT)
  })

  test('the deliberate reset is still reachable — EXPLICITLY, in the body', async () => {
    // Narrowing the implicit default must not remove the admin's ability to ask
    // for it: `{ status: 'locked', stage: 'ordered' }` takes the `stageProvided`
    // branch, whose effective status is this body's `locked`, so no 409.
    const cycle = await completedWithStage('ReLockExplicit', 'ready')
    const res = await patchCycle(cycle.id, { status: 'locked', stage: LOCK_DEFAULT })
    expect(res.status()).toBe(200)
    const after = await readCycle(cycle.id)
    expect(after.status).toBe('locked')
    expect(after.stage, 'asked for, so written').toBe(LOCK_DEFAULT)
  })

  test('⚠ the rule the narrowing must NOT touch: `open → locked` still writes `ordered`, even over a stale stage', async () => {
    // The counter-pin. `completed(ready) → open` (transition B) leaves `ready`
    // standing on an OPEN cycle, so this locks a row that already carries a
    // DIFFERENT stage — if the default had been narrowed away instead of scoped,
    // this reads `ready` and reds.
    const cycle = await completedWithStage('OpenThenLock', 'ready')
    expect((await patchCycle(cycle.id, { status: 'open' })).status()).toBe(200)
    const reopened = await readCycle(cycle.id)
    expect(reopened.status).toBe('open')
    expect(reopened.stage, 'precondition: B left the stale value').toBe('ready')

    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    const after = await readCycle(cycle.id)
    expect(after.status).toBe('locked')
    expect(after.stage, '§UC-CS-002: INTO locked from `open` ⇒ LOCKED_STAGE_DEFAULT').toBe(LOCK_DEFAULT)
  })

  test('A — `locked(ready) → planned` LEAVES the stale stage, deliberately (spec-conformant, not overlooked)', async () => {
    // §UC-CS-002: „`status: 'planned'` — unchanged from today (no stage
    // semantics)." Nothing authorises a clear, so nothing clears. Harmless because
    // `stageIndex()` consults `status` first and a planned round renders at step 0
    // whatever `stage` holds (pinned in the §UC-CS-005 section of this file).
    const cycle = await makeCycle('StaleToPlanned')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { stage: 'ready' })).status()).toBe(200)

    expect((await patchCycle(cycle.id, { status: 'planned' })).status()).toBe(200)
    const after = await readCycle(cycle.id)
    expect(after.status).toBe('planned')
    expect(after.stage, 'deliberate: `planned` has no stage semantics').toBe('ready')
  })

  test('B — `completed(ready) → open` LEAVES the stale stage, deliberately (spec-conformant, not overlooked)', async () => {
    // §UC-CS-002 scopes the clear to „`status: 'open'` WHILE THE CYCLE IS
    // `locked`". `completed → open` is not that, so the unlock branch does not
    // fire. Harmless for the same reason as A: an open round renders at step 1.
    const cycle = await completedWithStage('CompletedToOpen', 'ready')
    expect((await patchCycle(cycle.id, { status: 'open' })).status()).toBe(200)
    const after = await readCycle(cycle.id)
    expect(after.status).toBe('open')
    expect(after.stage, 'deliberate: the unlock branch is scoped to `locked`').toBe('ready')
  })

  test('`planned → locked` invents no stage — and `locked` + NULL IS `ordered` to every reader', async () => {
    // The narrowing's one other consequence, deliberate: locking a PLANNED round
    // now leaves `stage` as it stood. On a normally-planned round that is NULL,
    // which §UC-CS-001's no-backfill rule makes a first-class state — `stageIndex`
    // maps locked+NULL to 2 (`ordered`), the admin's „Káva dorazila" button renders
    // for NULL, and `markCycleReady()`'s predicate is `stage IS NULL OR stage <>
    // 'ready'`. So nothing on any screen differs; only the column stops being
    // written by a transition the table does not name.
    const cycle = await makeCycle('PlannedLock', { status: 'planned' })
    expect((await readCycle(cycle.id)).status, 'fixture: planned').toBe('planned')

    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    const after = await readCycle(cycle.id)
    expect(after.status).toBe('locked')
    expect(after.stage, 'no rule authorises a write here').toBe(null)

    // …and the hand-over seam still promotes such a row, so it is not a dead end.
    expect((await patchCycle(cycle.id, { stage: 'arrived' })).status(), 'still steerable by hand').toBe(200)
    expect((await readCycle(cycle.id)).stage).toBe('arrived')
  })

  test('…and a planned round carrying A\'s stale `ready` does not rewind when it is locked again', async () => {
    // The second rewind the narrowing removes: `locked(ready) → planned → locked`
    // used to land on `ordered` exactly the way C did. A stays unfixed, so this
    // chain is reachable.
    const cycle = await makeCycle('PlannedStaleLock')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { stage: 'ready' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { status: 'planned' })).status()).toBe(200)
    expect((await readCycle(cycle.id)).stage, 'precondition: A left the stale value').toBe('ready')

    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    const after = await readCycle(cycle.id)
    expect(after.status).toBe('locked')
    expect(after.stage).toBe('ready')
    expect(after.stage, 'the same rewind, one transition removed').not.toBe(LOCK_DEFAULT)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. §UC-CS-004 — payload publication
// ─────────────────────────────────────────────────────────────────────────────
test.describe('CS-T1 · 17 §UC-CS-004 — the three fields on every cycle payload', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Payloads', { opens_at: '2026-10-03', closes_at: '2026-10-10' })
    fx.product = await addProduct(fx.cycle.id)
    fx.host = await makeFriend('PayloadHost')
    await ownOrder(fx.host, fx.cycle.id, [{ product_id: fx.product.id, variant: '250g', quantity: 1 }])
    fx.link = await shareLink(fx.host, fx.cycle.id)
    fx.guest = await submitGuest(fx.link.token, `CS1 Hostka ${uniq}`, '0901234567',
      [{ product_id: fx.product.id, variant: '250g', quantity: 1 }])
  })

  test('the GUEST LISTING payload (`GET /api/guest/:token`) carries them', async () => {
    const res = await ctx.get(`/api/guest/${fx.link.token}`, { timeout: TIMEOUT })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(stageTriple(body.cycle)).toEqual({ opens_at: '2026-10-03', closes_at: '2026-10-10', stage: null })
    for (const leaked of ['shared_password', 'markup_ratio', 'total_friends']) {
      expect(Object.prototype.hasOwnProperty.call(body.cycle, leaked), `${leaked} stays out`).toBe(false)
    }
  })

  test('BOTH guest status URL forms carry a BYTE-EQUAL cycle block, and it tracks the admin row', async () => {
    const short = await ctx.get(`/api/guest/o/${fx.guest.order_token}`, { timeout: TIMEOUT })
    const long = await ctx.get(`/api/guest/${fx.link.token}/orders/${fx.guest.order_token}`, { timeout: TIMEOUT })
    expect(short.status()).toBe(200)
    expect(long.status()).toBe(200)
    const a = (await short.json()).cycle
    const b = (await long.json()).cycle
    expect(a, 'one payload, two doors').toEqual(b)
    expect(stageTriple(a)).toEqual({ opens_at: '2026-10-03', closes_at: '2026-10-10', stage: null })
    for (const leaked of ['shared_password', 'markup_ratio']) {
      expect(Object.prototype.hasOwnProperty.call(a, leaked), `${leaked} stays out`).toBe(false)
    }

    // the stage the guest reads IS the admin's row
    expect((await patchCycle(fx.cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(fx.cycle.id, { stage: 'arrived' })).status()).toBe(200)
    const after = await ctx.get(`/api/guest/o/${fx.guest.order_token}`, { timeout: TIMEOUT })
    expect((await after.json()).cycle.stage).toBe('arrived')
    expect((await readCycle(fx.cycle.id)).stage).toBe('arrived')
  })

  test('`GET /api/cycles/:id/public` carries them WITHOUT auth and leaks nothing', async () => {
    const res = await ctx.get(`/api/cycles/${fx.cycle.id}/public`, { timeout: TIMEOUT })
    expect(res.status()).toBe(200)
    const cycle = (await res.json()).cycle
    expect(stageTriple(cycle)).toEqual({ opens_at: '2026-10-03', closes_at: '2026-10-10', stage: 'arrived' })
    expect(Object.prototype.hasOwnProperty.call(cycle, 'shared_password'), 'no admin-only column').toBe(false)
  })

  test('`GET /api/friends/cycles` (Bearer) carries them on every cycle', async () => {
    const res = await ctx.get(`/api/friends/cycles?friendId=${fx.host.id}`, {
      headers: fx.host.auth, timeout: TIMEOUT,
    })
    expect(res.status()).toBe(200)
    const cycles = await res.json()
    expect(Array.isArray(cycles) && cycles.length, 'non-vacuous').toBeGreaterThan(0)
    for (const cycle of cycles) {
      for (const key of ['opens_at', 'closes_at', 'stage']) {
        expect(Object.prototype.hasOwnProperty.call(cycle, key), `${key} on cycle ${cycle.id}`).toBe(true)
      }
      expect(Object.prototype.hasOwnProperty.call(cycle, 'shared_password'), 'no admin-only column').toBe(false)
    }
    const mine = cycles.find((c) => c.id === fx.cycle.id)
    expect(stageTriple(mine)).toEqual({ opens_at: '2026-10-03', closes_at: '2026-10-10', stage: 'arrived' })
  })

  test('the ADMIN list and the single-cycle read carry them', async () => {
    const list = await (await admin('/api/cycles')).json()
    const mine = list.find((c) => c.id === fx.cycle.id)
    expect(stageTriple(mine)).toEqual({ opens_at: '2026-10-03', closes_at: '2026-10-10', stage: 'arrived' })
    expect(stageTriple(await readCycle(fx.cycle.id)))
      .toEqual({ opens_at: '2026-10-03', closes_at: '2026-10-10', stage: 'arrived' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. §UC-CS-003 — the module-16 seam, driven through 16's REAL endpoints
// ─────────────────────────────────────────────────────────────────────────────
test.describe('CS-T1 · 17 §UC-CS-003 — the hand-over seam', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Seam')
    fx.product = await addProduct(fx.cycle.id)
    fx.host = await makeFriend('SeamHost')
    fx.mate = await makeFriend('SeamMate')
    fx.hostOrder = await ownOrder(fx.host, fx.cycle.id, [{ product_id: fx.product.id, variant: '250g', quantity: 1 }])
    fx.mateOrder = await ownOrder(fx.mate, fx.cycle.id, [{ product_id: fx.product.id, variant: '250g', quantity: 1 }])
    fx.link = await shareLink(fx.host, fx.cycle.id)
    fx.guest = await submitGuest(fx.link.token, `CS1 SeamHostka ${uniq}`, '0901234567',
      [{ product_id: fx.product.id, variant: '250g', quantity: 1 }])

    // pack BEFORE the lock (`packed` is the money moment and needs no lock), then
    // lock — which is what puts the cycle in `ordered` and makes the seam reachable.
    await packParty(fx.cycle.id, fx.host.id, fx.hostOrder.id)
    await packParty(fx.cycle.id, fx.mate.id, fx.mateOrder.id)
    expect((await patchCycle(fx.cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await readCycle(fx.cycle.id)).stage, 'the seam starts from `ordered`').toBe('ordered')
  })

  test('the FIRST hand-over promotes the cycle to `ready` — and `status` does not move', async () => {
    const before = await ledgerSnapshot(fx.host.id)

    const res = await admin(`/api/orders/${fx.hostOrder.id}/handed-over`, {
      method: 'patch', data: { handed_over: true },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    // ⚠ THE RESPONSE FIELD IS THE STAGE STRING (16 §UC-DP-009 publishes
    // `cycle_stage: <string|null>`), not the helper's `{ changed }` flag.
    expect(body.cycle_stage, 'the published contract is a string').toBe('ready')
    expect(typeof body.cycle_stage).toBe('string')

    const after = await readCycle(fx.cycle.id)
    expect(after.stage).toBe('ready')
    expect(after.status, '⚠ NO AUTO-COMPLETE — the admin button is the only writer of `completed`').toBe('locked')

    // hand-over is LEDGER-NEUTRAL: `packed` was the money moment, before the lock.
    expect(await ledgerSnapshot(fx.host.id), 'no transactions row, no balance move').toEqual(before)
  })

  test('a SECOND hand-over is a no-op that still reports the stage', async () => {
    const res = await admin(`/api/orders/${fx.mateOrder.id}/handed-over`, {
      method: 'patch', data: { handed_over: true },
    })
    expect(res.status()).toBe(200)
    expect((await res.json()).cycle_stage, 'idempotent — the value, not the change').toBe('ready')
    expect((await readCycle(fx.cycle.id)).stage).toBe('ready')
  })

  test('UN-handing a bag never demotes the cycle', async () => {
    const res = await admin(`/api/orders/${fx.mateOrder.id}/handed-over`, {
      method: 'patch', data: { handed_over: false },
    })
    expect(res.status()).toBe(200)
    // ⚠ THE RESPONSE FIELD IS `null` HERE, AND THAT IS THE CONTRACT, not a demotion:
    // §UC-CS-003 says the clear path „calls nothing here", so 16's reversal branch
    // reports no stage at all. The claim this test makes is about the ROW.
    expect((await res.json()).cycle_stage, 'the clear path calls the seam at all').toBe(null)
    const after = await readCycle(fx.cycle.id)
    expect(after.stage, 'forward-only — the stage survives the reversal').toBe('ready')
    expect(after.status).toBe('locked')
  })

  test('a GUEST bag hand-over drives the same seam', async () => {
    // Walk the cycle back to `arrived` by hand (the admin correction §UC-CS-002
    // allows), so the guest route has something to promote.
    expect((await patchCycle(fx.cycle.id, { stage: 'arrived' })).status()).toBe(200)

    const res = await admin(`/api/guest-orders/${fx.guest.id}/handed-over`, {
      method: 'patch', data: { handed_over: true },
    })
    expect(res.status()).toBe(200)
    expect((await res.json()).cycle_stage).toBe('ready')
    expect((await readCycle(fx.cycle.id)).stage).toBe('ready')
  })

  test('the BULK hand-over drives it too, once per request', async () => {
    expect((await patchCycle(fx.cycle.id, { stage: 'ordered' })).status()).toBe(200)
    const res = await admin(`/api/cycles/${fx.cycle.id}/distribution/hand-over`, {
      method: 'post', data: { order_ids: [fx.mateOrder.id], guest_order_ids: [] },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.handed_over).toBe(1)
    expect(body.cycle_stage).toBe('ready')
    expect((await readCycle(fx.cycle.id)).stage).toBe('ready')
  })

  test('⚠ an OPEN cycle is not promoted — the helper is a no-op off `locked`', async () => {
    const cycle = await makeCycle('SeamOpen')
    const product = await addProduct(cycle.id)
    const friend = await makeFriend('SeamOpenFriend')
    const order = await ownOrder(friend, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await packParty(cycle.id, friend.id, order.id)

    const res = await admin(`/api/orders/${order.id}/handed-over`, {
      method: 'patch', data: { handed_over: true },
    })
    expect(res.status()).toBe(200)
    expect((await res.json()).cycle_stage, 'an open cycle has no stage to report').toBe(null)
    const after = await readCycle(cycle.id)
    expect(after.stage).toBe(null)
    expect(after.status, 'and the hand-over did NOT lock it either').toBe('open')
  })

  test('a hand-over on a COMPLETED cycle leaves the stage exactly as it was', async () => {
    const cycle = await makeCycle('SeamCompleted')
    const product = await addProduct(cycle.id)
    const friend = await makeFriend('SeamCompletedFriend')
    const order = await ownOrder(friend, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await packParty(cycle.id, friend.id, order.id)
    expect((await patchCycle(cycle.id, { status: 'locked', stage: 'arrived' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { status: 'completed' })).status()).toBe(200)

    const res = await admin(`/api/orders/${order.id}/handed-over`, {
      method: 'patch', data: { handed_over: true },
    })
    expect(res.status(), '16 allows the mis-click recovery').toBe(200)
    expect((await res.json()).cycle_stage, 'reported, not promoted').toBe('arrived')
    expect((await readCycle(cycle.id)).stage).toBe('arrived')
  })

  // ⚠ THE ROW THE NO-BACKFILL RULE CREATES — and the one the stub's superseded
  // contract (`stage IN ('ordered','arrived')`) would have left at NULL forever.
  // ~~Unreachable through the API~~ (locking writes `ordered`, unlocking also opens
  // the cycle, and `stage: null` is a 400) — ⚠ SUPERSEDED by FUP-T26 (2026-09-20):
  // the lock default fires from `open` only, so locking a PLANNED cycle now lands
  // here. The fixture still writes the row DIRECTLY and keeps its gate on purpose:
  // it must pin the PRE-MODULE state unconditionally, not by borrowing a second
  // rule that a later row could narrow again.
  test('a PRE-MODULE locked cycle (`stage IS NULL`) is promoted to `ready`', async () => {
    test.skip(!DB_PATH, 'needs DB_PATH: this manufactures the pre-module row rather than relying on another rule')
    const cycle = await makeCycle('SeamNullStage')
    const product = await addProduct(cycle.id)
    const friend = await makeFriend('SeamNullFriend')
    const order = await ownOrder(friend, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await packParty(cycle.id, friend.id, order.id)
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)

    withDb((db) => db.prepare('UPDATE order_cycles SET stage = NULL WHERE id = ?').run(cycle.id))
    const pre = await readCycle(cycle.id)
    expect(pre.status, 'the fixture is the pre-module state').toBe('locked')
    expect(pre.stage, 'and its stage is genuinely NULL').toBe(null)

    const res = await admin(`/api/orders/${order.id}/handed-over`, {
      method: 'patch', data: { handed_over: true },
    })
    expect(res.status()).toBe(200)
    expect((await res.json()).cycle_stage, 'NULL is in neither enum set — the predicate must be `IS NULL OR <> ready`').toBe('ready')
    expect((await readCycle(cycle.id)).stage).toBe('ready')
  })

  test('the whole seam wrote no `transactions` row at all', async () => {
    test.skip(!DB_PATH, 'needs DB_PATH for the global row count')
    // The API-level half is asserted per friend above; this is the global claim
    // the route could only break by writing a row under a NULL friend_id.
    const orphans = withDb((db) =>
      Number(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE friend_id IS NULL').get().n))
    expect(orphans, 'hand-over is ledger-neutral, on every path').toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// CS-T2 — 17 §UC-CS-005 / §UC-CS-006: `lib/cycle-stages.js`, the two new
// `lib/plural.js` declensions, and `components/CycleTimeline.vue`.
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠ WHY THIS SECTION IMPORTS THE LIB INSTEAD OF DRIVING A PAGE. There is no unit
// runner in this project and adding one is out of scope (01-architecture §Testing),
// but `lib/cycle-stages.js` is dependency-free plain ESM (it imports `./plural.js`
// and nothing else — no Vue, no `@/` alias), so a Playwright worker can import it
// directly. §UC-CS-009 item 4 asks for exactly that. It is also the ONLY way to
// reach these branches in this row: CS-T2 ships the component but mounts it
// nowhere — the guest status page is CS-T4, the admin header is CS-T3 — so there
// is no rendered surface to assert against yet.
//
// ⚠ THE GATE IS THE FRONTEND SOURCE TREE, never the lib file itself. "The module
// is missing" must be a RED run, not a silent skip — the vacuity trap the
// `DB_PATH` gates above carry by necessity. Against a deployment there is no
// `frontend/` beside `e2e/` and the whole section skips honestly (the
// `payment-links.spec.js` precedent).
const CS2_HERE = dirname(fileURLToPath(import.meta.url))
const CS2_FRONTEND_SRC = resolve(CS2_HERE, '../../frontend/src')
const CS2_NODE_MODULES = resolve(CS2_HERE, '../../frontend/node_modules')
const CS2_LIB = join(CS2_FRONTEND_SRC, 'lib/cycle-stages.js')
const CS2_PLURAL = join(CS2_FRONTEND_SRC, 'lib/plural.js')
const CS2_SFC = join(CS2_FRONTEND_SRC, 'components/CycleTimeline.vue')
const CS2_HAS_SRC = existsSync(CS2_FRONTEND_SRC)
const CS2_NEEDS_SRC = 'needs the frontend source beside e2e/ (skipped against a deployment)'

// A fixed "now" so the day/week arithmetic is not a function of when the suite runs.
const CS2_TODAY = new Date('2026-09-20T12:00:00')
/** The ISO date `n` calendar days after `CS2_TODAY`, in the SAME local zone. */
function cs2Day(n) {
  const d = new Date(CS2_TODAY)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Runs `fn` with the worker's timezone switched. Node re-reads `process.env.TZ`
 * for every `Date` created after the assignment, which is what lets a UTC box
 * exercise a DST boundary at all.
 */
function withTz(tz, fn) {
  const previous = process.env.TZ
  process.env.TZ = tz
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

/** The six labels, harvested from the lib — never re-typed here. */
let cs2 = null
let cs2Plural = null

// ─────────────────────────────────────────────────────────────────────────────
// 7. §UC-CS-005 — the step model
// ─────────────────────────────────────────────────────────────────────────────
test.describe('CS-T2 · 17 §UC-CS-005 — `stageIndex` and the step model', () => {
  test.skip(!CS2_HAS_SRC, CS2_NEEDS_SRC)

  test.beforeAll(async () => {
    cs2 = await import(pathToFileURL(CS2_LIB).href)
    cs2Plural = await import(pathToFileURL(CS2_PLURAL).href)
  })

  test('the six STEPS are exactly the spec table, in order', () => {
    expect(cs2.STEPS.map((s) => s.key)).toEqual(
      ['planned', 'open', 'ordered', 'arrived', 'ready', 'completed'])
    expect(cs2.STEPS.map((s) => s.label)).toEqual([
      'Pripravujeme ďalšiu objednávku',
      'Objednávky otvorené',
      'Objednávky uzavreté, káva objednaná v pražiarni',
      'Káva dorazila, balíme',
      'Zabalené, rozvážame',
      'Objednávka ukončená',
    ])
  })

  test('`stageIndex` — the whole table, including locked+NULL ⇒ 2', () => {
    expect(cs2.stageIndex(null), 'no cycle').toBe(0)
    expect(cs2.stageIndex(undefined), 'undefined').toBe(0)
    expect(cs2.stageIndex('open'), 'a string is not a cycle').toBe(0)
    expect(cs2.stageIndex({ status: 'planned' })).toBe(0)
    expect(cs2.stageIndex({ status: 'open' })).toBe(1)
    expect(cs2.stageIndex({ status: 'locked', stage: null }), 'the no-backfill row').toBe(2)
    expect(cs2.stageIndex({ status: 'locked' }), 'stage absent entirely').toBe(2)
    expect(cs2.stageIndex({ status: 'locked', stage: 'ordered' })).toBe(2)
    expect(cs2.stageIndex({ status: 'locked', stage: 'arrived' })).toBe(3)
    expect(cs2.stageIndex({ status: 'locked', stage: 'ready' })).toBe(4)
    expect(cs2.stageIndex({ status: 'completed' })).toBe(5)
    expect(cs2.stageIndex({ status: 'draft' }), 'an unknown status').toBe(0)
  })

  test('⚠ `status` is consulted BEFORE `stage` — the stale-stage rows CS-T1 measured stay off the screen', () => {
    // docs/learnings/09-cycle-stages.md §10. ⚠ FUP-T26 (2026-09-20) closed the
    // third of those rows at the SOURCE — `completed → locked` no longer resets
    // the stage — so what survives here is A and B: two transitions §UC-CS-002
    // deliberately leaves alone, which therefore still leave a `stage` that
    // disagrees with its `status`. Both are invisible ONLY because this function
    // reads `status` first. Nothing else in the suite pins that ordering, so this
    // test is still it.
    //
    // ⚠ Every row below carries `stage: 'ready'` or `'ordered'`, i.e. a value a
    // stage-first implementation would map to a DIFFERENT index (4 / 2) — the
    // assertion pair is index + label, and the follow-up asserts the index is not
    // the one the stale value would have produced. A fixture whose stale stage
    // happened to agree with its status would prove nothing at all.
    const A = { status: 'planned', stage: 'ready' }   // locked(ready) → planned
    const B = { status: 'open', stage: 'ready' }      // completed(ready) → open
    // ⚠ FUP-T26 (2026-09-20): row C's PROVENANCE is superseded — ~~`completed(ready)
    // → locked`~~ no longer produces this row at all; the lock default now fires
    // from `open` only, so that transition keeps `ready` (pinned server-side in the
    // FUP-T26 describe above). The row stays because `locked` + `ordered` is still
    // a real state — reached by `open → locked` — and it is the ordering claim's
    // FIXED POINT: under `locked` a stage-first read agrees with a status-first one
    // by construction. A and B are what discriminate; C only documents the step.
    const C = { status: 'locked', stage: 'ordered' }  // open → locked

    expect(cs2.stageIndex(A), 'A: a planned round renders as planned').toBe(0)
    expect(cs2.stageIndex(A), 'A: never as `ready`').not.toBe(4)
    expect(cs2.STEPS[cs2.stageIndex(A)].label).toBe('Pripravujeme ďalšiu objednávku')

    expect(cs2.stageIndex(B), 'B: a re-opened round renders as open').toBe(1)
    expect(cs2.stageIndex(B), 'B: never as `ready`').not.toBe(4)
    expect(cs2.STEPS[cs2.stageIndex(B)].label).toBe('Objednávky otvorené')

    expect(cs2.stageIndex(C), 'C: a re-locked round renders where its stage says').toBe(2)
    expect(cs2.STEPS[cs2.stageIndex(C)].label).toBe('Objednávky uzavreté, káva objednaná v pražiarni')

    // And the historical stage on a COMPLETED round is never current, whatever it is.
    for (const stage of ['ordered', 'arrived', 'ready', null]) {
      expect(cs2.stageIndex({ status: 'completed', stage }), `completed + ${stage}`).toBe(5)
    }
  })

  test('`timelineSteps` — done / now / next around the current step, and the `when` lines', () => {
    const steps = cs2.timelineSteps({
      status: 'locked', stage: 'arrived', opens_at: '2026-09-05', closes_at: '2026-09-12',
    })
    expect(steps).toHaveLength(6)
    expect(steps.filter((s) => s.state === 'done')).toHaveLength(3)
    expect(steps.filter((s) => s.state === 'now')).toHaveLength(1)
    expect(steps.filter((s) => s.state === 'next')).toHaveLength(2)
    expect(steps.find((s) => s.state === 'now').label).toBe('Káva dorazila, balíme')
    expect(steps.map((s) => s.when)).toEqual(
      ['otvorí sa 5. septembra', 'do 12. septembra', '12. septembra', '', '', ''])
    expect(steps.map((s) => s.desc), 'desc is the consumers\' slot, empty in v1')
      .toEqual(['', '', '', '', '', ''])
    expect(steps.map((s) => s.key)).toEqual(cs2.STEPS.map((s) => s.key))
  })

  test('`timelineSteps` — a planned round with only an opening date', () => {
    const steps = cs2.timelineSteps({ status: 'planned', opens_at: '2026-10-03' })
    expect(steps[0].state).toBe('now')
    expect(steps[0].when).toBe('otvorí sa 3. októbra')
    expect(steps.slice(1).every((s) => s.state === 'next')).toBe(true)
    expect(steps.slice(1).map((s) => s.when), 'no deadline ⇒ no `when` anywhere else')
      .toEqual(['', '', '', '', ''])
  })

  test('`timelineSteps(null)` is the step-0 timeline, not an empty one', () => {
    const steps = cs2.timelineSteps(null)
    expect(steps).toHaveLength(6)
    expect(steps[0].state).toBe('now')
    expect(steps.map((s) => s.when)).toEqual(['', '', '', '', '', ''])
  })

  test('`STEPS` cannot be edited from a consumer', () => {
    expect(() => { cs2.STEPS[0] = { key: 'x', label: 'x' } }).toThrow()
    expect(cs2.STEPS[0].label).toBe('Pripravujeme ďalšiu objednávku')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. §UC-CS-005 — dates, the „o n týždňov" derivation and the copy builders
// ─────────────────────────────────────────────────────────────────────────────
test.describe('CS-T2 · 17 §UC-CS-005 — dates and copy', () => {
  test.skip(!CS2_HAS_SRC, CS2_NEEDS_SRC)

  test.beforeAll(async () => {
    cs2 = await import(pathToFileURL(CS2_LIB).href)
    cs2Plural = await import(pathToFileURL(CS2_PLURAL).href)
  })

  test('`fmtDay` prints the Slovak genitive month and no year', () => {
    expect(cs2.fmtDay('2026-10-03')).toBe('3. októbra')
    expect(cs2.fmtDay('2026-09-12')).toBe('12. septembra')
    expect(cs2.fmtDay('2026-01-01')).toBe('1. januára')
    expect(cs2.fmtDay('2026-10-03')).not.toMatch(/2026/)
    // ⚠ The DISPLAY date is built from LOCAL midnight on purpose: format the UTC
    // instant instead and a viewer west of Greenwich reads the day before.
    withTz('America/New_York', () => {
      expect(cs2.fmtDay('2026-10-03'), 'the stored day, not the viewer\'s instant').toBe('3. októbra')
    })
  })

  test('⚠ an IMPOSSIBLE calendar day is `\'\'`, not silently rolled forward', () => {
    // `new Date('2026-02-31T00:00:00')` is **3 March** in V8, not Invalid Date — a
    // shape-only check would print „3. marca" for a date the user never chose.
    expect(cs2.fmtDay('2026-02-31')).toBe('')
    // ⚠ NON-VACUITY: the very day it would have rolled to formats perfectly, so the
    // empty string above is a refusal, not a broken formatter.
    expect(cs2.fmtDay('2026-03-03')).toBe('3. marca')
  })

  test('`fmtDay` never throws and never prints „Invalid Date"', () => {
    for (const junk of ['2026-13-40', '2026-1-3', '03.10.2026', '', '   ', 'zajtra',
      null, undefined, 20261003, {}, [], new Date()]) {
      expect(cs2.fmtDay(junk), `fmtDay(${JSON.stringify(junk)})`).toBe('')
    }
  })

  test('`daysUntil` counts whole CALENDAR days, and junk is `null`', () => {
    expect(cs2.daysUntil(cs2Day(0), CS2_TODAY), 'today').toBe(0)
    expect(cs2.daysUntil(cs2Day(1), CS2_TODAY)).toBe(1)
    expect(cs2.daysUntil(cs2Day(13), CS2_TODAY)).toBe(13)
    expect(cs2.daysUntil(cs2Day(-4), CS2_TODAY), 'a past date is negative').toBe(-4)
    // ⚠ THE DST ASSERTION ONLY MEANS ANYTHING IN A ZONE THAT HAS DST, and this
    // box runs on UTC — measured: the naive local-time implementation passes here
    // unchanged, i.e. the fixture would be a fixed point of the mutation it claims
    // to catch. So the worker's zone is switched for the duration: across 25
    // October 2026 the local-time difference is 12 days and 1 HOUR, which a naive
    // subtraction reports as 12.0416…, while UTC-midnight arithmetic is exact.
    withTz('Europe/Bratislava', () => {
      expect(cs2.daysUntil('2026-11-01', new Date('2026-10-20T12:00:00')),
        'the autumn boundary').toBe(12)
      expect(cs2.daysUntil('2026-04-01', new Date('2026-03-20T12:00:00')),
        'the spring boundary').toBe(12)
      expect(cs2.daysUntil('2026-11-01', new Date('2026-10-20T23:30:00')),
        'late in the evening, an hour from rolling over').toBe(12)
    })
    for (const junk of ['2026-02-31', '2026-13-40', 'zajtra', null, 20261003, {}]) {
      expect(cs2.daysUntil(junk, CS2_TODAY), `daysUntil(${JSON.stringify(junk)})`).toBeNull()
    }
    expect(cs2.daysUntil('2026-10-03', 'nie je dátum'), 'an unusable `today`').toBeNull()
  })

  test('`inWeeksText` — „o n dní" under a week, „o n týždňov" from seven days up', () => {
    expect(cs2.inWeeksText(cs2Day(1), CS2_TODAY)).toBe('o 1 deň')
    expect(cs2.inWeeksText(cs2Day(3), CS2_TODAY)).toBe('o 3 dni')
    expect(cs2.inWeeksText(cs2Day(6), CS2_TODAY)).toBe('o 6 dní')
    expect(cs2.inWeeksText(cs2Day(7), CS2_TODAY)).toBe('o 1 týždeň')
    expect(cs2.inWeeksText(cs2Day(18), CS2_TODAY)).toBe('o 3 týždne')
    expect(cs2.inWeeksText(cs2Day(35), CS2_TODAY)).toBe('o 5 týždňov')
  })

  test('`inWeeksText` has nothing to announce for today, the past, or junk', () => {
    expect(cs2.inWeeksText(cs2Day(0), CS2_TODAY), 'today').toBeNull()
    expect(cs2.inWeeksText(cs2Day(-1), CS2_TODAY), 'yesterday').toBeNull()
    expect(cs2.inWeeksText(cs2Day(-40), CS2_TODAY)).toBeNull()
    expect(cs2.inWeeksText('2026-02-31', CS2_TODAY)).toBeNull()
    expect(cs2.inWeeksText(null, CS2_TODAY)).toBeNull()
  })

  test('the declensions come from `plural.js`, not from a second copy in the lib', () => {
    // The one-home claim, asserted as DELEGATION rather than as a grep: the
    // sentence must be byte-identical to the label `plural.js` produces.
    expect(cs2Plural.daysLabel(3)).toBe('3 dni')
    expect(cs2Plural.weeksLabel(3)).toBe('3 týždne')
    expect(cs2.inWeeksText(cs2Day(3), CS2_TODAY)).toBe(`o ${cs2Plural.daysLabel(3)}`)
    expect(cs2.inWeeksText(cs2Day(21), CS2_TODAY)).toBe(`o ${cs2Plural.weeksLabel(3)}`)
  })

  test('`daysLabel` / `weeksLabel` — all three branches each', () => {
    expect([1, 2, 4, 5, 11, 0].map(cs2Plural.daysLabel))
      .toEqual(['1 deň', '2 dni', '4 dni', '5 dní', '11 dní', '0 dní'])
    expect([1, 2, 4, 5, 12, 0].map(cs2Plural.weeksLabel))
      .toEqual(['1 týždeň', '2 týždne', '4 týždne', '5 týždňov', '12 týždňov', '0 týždňov'])
  })

  test('`nextOpeningText` — branch 1: a planned round with an opening date', () => {
    const out = cs2.nextOpeningText({ status: 'planned', opens_at: cs2Day(28) }, CS2_TODAY)
    expect(out.date).toBe(cs2.fmtDay(cs2Day(28)))
    expect(out.inWeeks).toBe('o 4 týždne')
    expect(out.text).toBe(`Ďalšia objednávka sa otvorí približne ${out.date} (o 4 týždne).`)
  })

  test('`nextOpeningText` — a date already reached loses the parenthesis, not the sentence', () => {
    const out = cs2.nextOpeningText({ status: 'planned', opens_at: cs2Day(0) }, CS2_TODAY)
    expect(out.inWeeks).toBeNull()
    expect(out.text).toBe(`Ďalšia objednávka sa otvorí približne ${out.date}.`)
    expect(out.text, 'no empty parenthesis').not.toMatch(/\(\s*\)/)
  })

  test('`nextOpeningText` — branch 2: the plan note, VERBATIM, newlines kept', () => {
    const note = 'Ešte nevieme presne.\nPravdepodobne po sviatkoch.'
    const out = cs2.nextOpeningText({ status: 'planned', opens_at: null, plan_note: note }, CS2_TODAY)
    expect(out).toEqual({ date: null, inWeeks: null, text: note })
  })

  test('`nextOpeningText` — branch 3: nothing planned', () => {
    const expected = { date: null, inWeeks: null, text: 'O ďalšej objednávke dáme vedieť.' }
    expect(cs2.nextOpeningText(null, CS2_TODAY)).toEqual(expected)
    expect(cs2.nextOpeningText(undefined, CS2_TODAY)).toEqual(expected)
    expect(cs2.nextOpeningText({ status: 'planned' }, CS2_TODAY), 'neither date nor note').toEqual(expected)
    expect(cs2.nextOpeningText({ status: 'planned', plan_note: '   ' }, CS2_TODAY), 'a blank note is no note')
      .toEqual(expected)
  })

  test('⚠ an unusable `opens_at` falls through to the note — never a sentence with a hole in it', () => {
    const out = cs2.nextOpeningText(
      { status: 'planned', opens_at: '2026-02-31', plan_note: 'Niekedy v marci.' }, CS2_TODAY)
    expect(out.text).toBe('Niekedy v marci.')
    expect(out.text, 'the sentence is not composed around an empty date')
      .not.toMatch(/približne\s*[.(]/)
  })

  test('`openUntilText` — with and without a deadline', () => {
    expect(cs2.openUntilText({ status: 'open', closes_at: '2026-09-12' }))
      .toBe('Objednávky otvorené · do 12. septembra')
    expect(cs2.openUntilText({ status: 'open', closes_at: null })).toBe('Objednávky otvorené')
    expect(cs2.openUntilText({ status: 'open', closes_at: '2026-02-31' }), 'an unusable deadline')
      .toBe('Objednávky otvorené')
    expect(cs2.openUntilText(null)).toBe('Objednávky otvorené')
    // The bare form is a PREFIX of the dated one and identical to step 1's label —
    // one wording, two lengths.
    expect(cs2.openUntilText({})).toBe(cs2.STEPS[1].label)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. §UC-CS-005 — `currentCycleFor`, the one place "the current round" is decided
// ─────────────────────────────────────────────────────────────────────────────
test.describe('CS-T2 · 17 §UC-CS-005 — `currentCycleFor`', () => {
  test.skip(!CS2_HAS_SRC, CS2_NEEDS_SRC)
  test.beforeAll(async () => { cs2 = await import(pathToFileURL(CS2_LIB).href) })

  const row = (id, status, created_at) => ({ id, status, created_at, name: `c${id}` })

  test('open beats locked beats planned, and `completed` is never current', () => {
    const planned = row(1, 'planned', '2026-09-01 10:00:00')
    const locked = row(2, 'locked', '2026-09-02 10:00:00')
    const open = row(3, 'open', '2026-08-01 10:00:00')
    const done = row(4, 'completed', '2026-09-30 10:00:00')
    expect(cs2.currentCycleFor([planned, locked, open, done]).id, 'open wins even when it is the oldest').toBe(3)
    expect(cs2.currentCycleFor([planned, locked, done]).id, 'then locked').toBe(2)
    expect(cs2.currentCycleFor([planned, done]).id, 'then planned').toBe(1)
    expect(cs2.currentCycleFor([done]), 'a finished round is not current').toBeNull()
  })

  test('“newest” is `created_at` DESC then `id` DESC — the second-resolution tie', () => {
    const same = '2026-09-02 10:00:00'
    expect(cs2.currentCycleFor([row(7, 'locked', same), row(9, 'locked', same), row(8, 'locked', same)]).id,
      'same second ⇒ the higher id').toBe(9)
    expect(cs2.currentCycleFor([
      row(9, 'locked', '2026-09-01 10:00:00'),
      row(2, 'locked', '2026-09-05 10:00:00'),
    ]).id, 'a newer timestamp beats a higher id').toBe(2)
  })

  test('two rounds open at once: the newest wins and a `console.warn` names it (R1.2)', () => {
    const warnings = []
    const original = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const picked = cs2.currentCycleFor([
        row(4, 'open', '2026-09-01 10:00:00'),
        row(5, 'open', '2026-09-08 10:00:00'),
      ])
      expect(picked.id).toBe(5)
    } finally {
      console.warn = original
    }
    expect(warnings, 'exactly one warning').toHaveLength(1)
    expect(warnings[0]).toMatch(/2/)
    expect(warnings[0].toLowerCase()).toMatch(/open/)
  })

  test('ONE open round warns about nothing', () => {
    const warnings = []
    const original = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      expect(cs2.currentCycleFor([row(4, 'open', '2026-09-01 10:00:00'), row(5, 'locked', '2026-09-08 10:00:00')]).id)
        .toBe(4)
    } finally {
      console.warn = original
    }
    expect(warnings, 'the warning is about the data error, not about every call').toHaveLength(0)
  })

  test('an empty list, a non-array and junk rows are `null`, never a throw', () => {
    expect(cs2.currentCycleFor([])).toBeNull()
    expect(cs2.currentCycleFor(null)).toBeNull()
    expect(cs2.currentCycleFor(undefined)).toBeNull()
    expect(cs2.currentCycleFor('open')).toBeNull()
    expect(cs2.currentCycleFor([null, undefined, 'x', 7])).toBeNull()
    expect(cs2.currentCycleFor([null, row(3, 'open', '2026-09-01 10:00:00')]).id).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. §UC-CS-005 / §UC-CS-006 — the vocabulary ban, swept NON-VACUOUSLY
// ─────────────────────────────────────────────────────────────────────────────
// Resolved conflict 2 + the 00-overview glossary: every friend- and guest-facing
// string in module 17 says „objednávka". „cyklus" survives on ADMIN screens only.
//
// ⚠ NOT §UC-CS-009's literal `/kol[oáa]\b|cykl/i`, and both differences are
// measured, not stylistic:
//   · that regex does NOT match „kolá" — `á` is outside ASCII `\w`, so the
//     trailing `\b` never fires after it. A ban that misses one of the four words
//     it names is a ban that passes on the string it exists to catch.
//   · it DOES match „okolo", which is module 18's own copy („Káva príde okolo
//     {expected_date}", PO decision O2) — a false positive waiting for the first
//     consumer that reuses this sweep.
// A leading `\b` plus the `u` flag fixes both, and the test below proves the
// regex on both lists rather than asserting it on faith.
//
// ⚠ MODULE-SCOPED since CS-T4, which sweeps the RENDERED guest status page with the
// same regex (§UC-CS-008). Two copies of a ban is how the two halves start banning
// different words; the „the regex itself catches what it claims to catch" test
// below is the single proof for both readers.
//
// ⚠⚠ IMPORTED SINCE PI-T11, and module-scoped was not far enough: 18 §UC-PI-017 needed
// the same ban for the FRIEND surface and carried a third spelling of it, so the one
// home moved OUT of this file into `e2e/helpers/vocabulary.js`. The union it exports is
// a superset of what this file used to ban on „kole"/„kolu" and a strict subset on
// „kolaps"/„kolotoč" (which `\bkol[oáa]` matched and nothing here ever meant to ban) —
// the two case tables below are what proves this file lost nothing it cared about.

test.describe('CS-T2 · 17 §UC-CS-005 — no „kolo", no „cyklus", anywhere', () => {
  test.skip(!CS2_HAS_SRC, CS2_NEEDS_SRC)
  test.beforeAll(async () => { cs2 = await import(pathToFileURL(CS2_LIB).href) })

  /** Every string the module EXPORTS or BUILDS, harvested by calling it. */
  function harvest() {
    const strings = []
    const push = (v) => { if (typeof v === 'string' && v.trim()) strings.push(v) }
    const cycles = [
      null,
      { status: 'planned', opens_at: '2026-10-03' },
      { status: 'planned', plan_note: 'Otvoríme to po sviatkoch.' },
      { status: 'open', opens_at: '2026-09-05', closes_at: '2026-09-12' },
      { status: 'locked', stage: null, closes_at: '2026-09-12' },
      { status: 'locked', stage: 'arrived', closes_at: '2026-09-12' },
      { status: 'locked', stage: 'ready', closes_at: '2026-09-12' },
      { status: 'completed', stage: 'ready', opens_at: '2026-09-05', closes_at: '2026-09-12' },
    ]
    for (const step of cs2.STEPS) push(step.label)
    for (const cycle of cycles) {
      for (const step of cs2.timelineSteps(cycle)) { push(step.label); push(step.when); push(step.desc) }
      push(cs2.openUntilText(cycle))
      const next = cs2.nextOpeningText(cycle, CS2_TODAY)
      push(next.text); push(next.date); push(next.inWeeks)
    }
    for (const n of [1, 2, 3, 5, 7, 14, 30, 60]) push(cs2.inWeeksText(cs2Day(n), CS2_TODAY))
    push(cs2.nextOpeningText(null, CS2_TODAY).text)
    return strings
  }

  test('⚠ the sweep, with its non-vacuity gate: ≥ 6 labels harvested, zero matches', () => {
    const strings = harvest()
    // ⚠ THE GATE. An absence assertion over an EMPTY harvest passes for the wrong
    // reason, and this repo has been bitten by exactly that. So: the six labels
    // must be present by IDENTITY (not by count of some array we built), and the
    // whole harvest must be substantially bigger than them.
    const labels = cs2.STEPS.map((s) => s.label)
    expect(labels, 'the step model still has six labels').toHaveLength(6)
    for (const label of labels) {
      expect(strings, `the sweep saw the label „${label}"`).toContain(label)
    }
    // ⚠ THE GATE ABOVE WAS ITSELF VACUOUS UNTIL CS-T2 REVIEW (2026-09-20). It read
    // `expect(strings.length).toBeGreaterThanOrEqual(30)` — but the labels alone
    // contribute 54 strings (6 + 8 fixtures × 6), so every BUILDER could have returned
    // `''` and the gate would still have passed while claiming it "saw the built
    // sentences". A non-vacuity gate that cannot fail is the bug it exists to prevent.
    // Builders are now required BY IDENTITY, like the labels.
    expect(strings, 'the sweep saw openUntilText()').toContain(
      cs2.openUntilText({ status: 'open', closes_at: '2026-09-12' }),
    )
    expect(strings, 'the sweep saw nextOpeningText() branch 1').toContain(
      cs2.nextOpeningText({ status: 'planned', opens_at: '2026-10-03' }, CS2_TODAY).text,
    )
    expect(strings, 'the sweep saw nextOpeningText() branch 3 (no planned cycle)').toContain(
      cs2.nextOpeningText(null, CS2_TODAY).text,
    )
    expect(strings, 'the sweep saw inWeeksText()').toContain(cs2.inWeeksText(cs2Day(14), CS2_TODAY))

    const offenders = strings.filter((s) => BANNED.test(s))
    expect(offenders, 'no friend-facing string in module 17 may say „kolo" or „cyklus"').toEqual([])
  })

  test('⚠ the regex itself catches what it claims to catch', () => {
    // A ban whose regex matches nothing is the same bug as a sweep over nothing.
    for (const bad of ['Pripravujeme ďalšie kolo', 'Kolo ukončené', 'Objednávanie v tomto cykle je uzavreté',
      'cyklus', 'dve kolá', 'v troch kolách', '„kolo"']) {
      expect(BANNED.test(bad), `the sweep would catch „${bad}"`).toBe(true)
    }
    // And the words this app says on purpose are NOT offenders — „kolega" is the
    // host's word for the people on their link, and „okolo" is module 18's.
    for (const good of ['Pripravujeme ďalšiu objednávku', 'Objednávka ukončená', 'Zabalené, rozvážame',
      '1 kolega', '5 kolegov', 'Káva príde okolo 24. 9.']) {
      expect(BANNED.test(good), `„${good}" is not a false positive`).toBe(false)
    }
  })

  test('the SOURCE of both files is clean too, not only the reachable strings', () => {
    // The harvest above covers what a user can reach; this catches a banned word
    // parked in a branch no fixture exercises, or in the component's markup.
    //
    // ⚠ COMMENTS ARE STRIPPED FIRST, and that is not the usual "grep everything,
    // comments included" rule being weakened: the two headers NAME „kolo" and
    // „cyklus" precisely in order to ban them, so a raw line sweep reds on its own
    // documentation. The non-vacuity gate below is what keeps the strip honest —
    // a strip that ate the file would pass this test for the wrong reason.
    const strip = (text) => text
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ')
    for (const [file, canary] of [[CS2_LIB, cs2.STEPS[0].label], [CS2_SFC, 'Krok ']]) {
      const stripped = strip(readFileSync(file, 'utf8'))
      expect(stripped, `the strip left ${file.split('/').pop()} standing`).toContain(canary)
      const hits = stripped.split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => BANNED.test(line))
      expect(hits.map(([n, l]) => `${file.split('/').pop()}:${n} ${l.trim()}`)).toEqual([])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. §UC-CS-006 — `CycleTimeline.vue`: ONE component, two variants, three skins
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ These are SOURCE-level assertions, and that is a deliberate choice, not a
// shortcut: CS-T2 mounts the component nowhere (CS-T3 puts it in the admin header,
// CS-T4 on the guest status page), so there is no rendered DOM to query in this
// row. What IS provable here is the set of properties that no later row's test
// would notice being broken — that the SFC compiles at all, that its styles carry
// no `.app` / `.modal-layer` ancestor, that every token has a fallback, and that it
// re-types none of the lib's Slovak. ~~The rendered `done`/`now`/`next` counts and
// the computed `.mk` border (§UC-CS-009 item 1) belong to CS-T3/CS-T4, which have
// a page to load.~~ ⚠ **SUPERSEDED TWICE — see the CS-T4 header block below.** CS-T3
// delivered the counts and the fallback measurement on the COMPACT `.d` (the admin page
// is the only surface that renders this component with the portal tokens absent), and
// CS-T4 established that the `.mk` reading CANNOT be delivered at all: the guest status
// page's `.app` root supplies `--nb-ink` with a value byte-identical to the fallback, so
// the assertion passes with every fallback deleted. §UC-CS-009 is amended to match.
test.describe('CS-T2 · 17 §UC-CS-006 — CycleTimeline.vue', () => {
  test.skip(!CS2_HAS_SRC, CS2_NEEDS_SRC)

  let src = ''
  let descriptor = null
  let styleCss = ''

  test.beforeAll(async () => {
    cs2 = await import(pathToFileURL(CS2_LIB).href)
    expect(existsSync(CS2_SFC), 'components/CycleTimeline.vue must exist (§UC-CS-006)').toBe(true)
    src = readFileSync(CS2_SFC, 'utf8')
    const sfcCompiler = join(CS2_NODE_MODULES, '@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js')
    test.skip(!existsSync(sfcCompiler), 'needs frontend/node_modules for the SFC compile')
    const sfc = await import(pathToFileURL(sfcCompiler).href)
    const parsed = sfc.parse(src, { filename: 'CycleTimeline.vue' })
    expect(parsed.errors.map(String), 'the SFC parses').toEqual([])
    descriptor = parsed.descriptor
    const script = sfc.compileScript(descriptor, { id: 'cst2' })
    const tpl = sfc.compileTemplate({
      source: descriptor.template.content,
      filename: 'CycleTimeline.vue',
      id: 'cst2',
      scoped: true,
      compilerOptions: { bindingMetadata: script.bindings },
    })
    expect(tpl.errors.map(String), 'the template compiles').toEqual([])
    for (const style of descriptor.styles) {
      const out = sfc.compileStyle({
        source: style.content, filename: 'CycleTimeline.vue', id: 'data-v-cst2', scoped: style.scoped,
      })
      expect(out.errors.map(String), 'the scoped CSS compiles').toEqual([])
      styleCss += out.code
    }
  })

  test('ONE component, both variants, each with its own testid', () => {
    expect(src).toContain('data-testid="cycle-timeline"')
    expect(src).toContain('data-testid="cycle-timeline-compact"')
    expect(src.match(/variant === 'compact'/g), 'one switch, not two components').toHaveLength(1)
  })

  test('every label comes from the lib — the component re-types no Slovak but its aria-label', () => {
    for (const label of cs2.STEPS.map((s) => s.label)) {
      expect(src, `„${label}" must live only in lib/cycle-stages.js`).not.toContain(label)
    }
    expect(src, 'the step model is imported, not re-declared')
      .toMatch(/import \{[^}]*timelineSteps[^}]*\} from '\.\.\/lib\/cycle-stages\.js'/)
    expect(src, 'the one Slovak string it owns').toContain('Krok ')
    // The compact strip is one `role="img"`, so the label must name the step.
    expect(src).toContain('role="img"')
    expect(src).toContain(':aria-label="dotsLabel"')
  })

  test('⚠ the styles are scoped, and carry no `.app` / `.modal-layer` ancestor', () => {
    expect(descriptor.styles, 'exactly one style block').toHaveLength(1)
    expect(descriptor.styles[0].scoped, '<style scoped>').toBe(true)
    // ⚠ COMMENTS STRIPPED FIRST: the ported block NAMES `.app` in a comment to say
    // the prefix was dropped, so a raw grep over the CSS has a hit that is not a
    // selector. Strip, then assert.
    const selectors = styleCss.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(selectors, 'the portal skin is not an ancestor requirement').not.toContain('.app')
    expect(selectors, 'neither is the modal layer').not.toContain('.modal-layer')
    expect(selectors, 'no theme file was edited from here').toContain('.cs-tl')
    expect(selectors).toContain('.cs-dots')
  })

  test('⚠ every design token is read through a FALLBACK (the admin skin defines none)', () => {
    const css = styleCss.replace(/\/\*[\s\S]*?\*\//g, '')
    const vars = css.match(/var\(--[a-z-]+[^)]*\)/g) || []
    // Non-vacuity: a component that stopped using tokens would otherwise pass this.
    expect(vars.length, 'the component still themes itself through tokens').toBeGreaterThanOrEqual(10)
    const bare = vars.filter((v) => !v.includes(','))
    expect(bare, 'a token with no fallback renders as nothing on the admin page').toEqual([])
  })

  test('⚠ nothing here depends on the `.app > *` cascade', () => {
    const css = styleCss.replace(/\/\*[\s\S]*?\*\//g, '')
    // CLAUDE.md: `fixed`/`sticky`/`z-*` on a direct child of `.app` silently
    // computes to `relative`/`1`. The component must not need any of them; the one
    // `position: absolute` is the connector rule, positioned against `.st`.
    expect(css).not.toMatch(/position\s*:\s*(fixed|sticky)/)
    expect(css, 'no stacking context to lose').not.toMatch(/z-index/)
    const absolutes = css.match(/position\s*:\s*absolute/g) || []
    expect(absolutes, 'only the `.st::before` connector').toHaveLength(1)
    expect(css, 'and its containing block is `.st`, a grandchild').toMatch(/\.st[^{]*\{[^}]*position\s*:\s*relative/)
  })

  test('the prototype port kept the numbers (`portal2.css:22-42`)', () => {
    const css = styleCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '')
    for (const decl of [
      'left:13px', 'top:28px', 'border-left:3pxsolidrgba(10,10,10,0.18)',   // the connector
      'width:28px', 'height:28px', 'border-radius:8px',                      // the vertical marker
      'font-size:20px',                                                      // the `now` label
      'font-size:11.5px', 'letter-spacing:0.04em',                           // the `when` line
      'width:22px', 'height:22px', 'border-radius:6px',                      // the dots
      'border-top:3pxsolidrgba(10,10,10,0.25)',                              // the dot connector
    ]) {
      expect(css, `ported declaration ${decl}`).toContain(decl)
    }
  })

  test('the `now` label carries its `line-height` INLINE', () => {
    // CLAUDE.md §Frontend: `line-height` often has to be inline here, and
    // §UC-CS-006 names this label specifically.
    expect(src).toMatch(/:style="s\.state === 'now' \? \{ lineHeight: '1' \} : null"/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 12. CS-T3 · §UC-CS-007 — the admin controls on `CycleDetail.vue`
//
// ⚠ THIS IS THE FIRST MOUNT OF `CycleTimeline.vue` ANYWHERE. CS-T2 shipped the
// component and mounted it nowhere, so everything it guarantees was pinned at
// SOURCE level only (the SFC compiles, one scoped style block, no `.app` selector,
// every token behind a fallback). §UC-CS-009 item 1's RENDERED half therefore lands
// here: the `done` / `now` / `next` counts off the live DOM, and the marker border
// read out of `getComputedStyle` on a page that has no `.app` ancestor at all —
// which is the entire reason the port carries fallbacks.
//
// ⚠ ONE ADMIN TOKEN APP-WIDE. Every test below logs in through the BROWSER first
// and adopts that token before it builds its fixture through the API; a UI login
// mints a new row and invalidates whatever `beforeAll` minted.
//
// ⚠ THE INDEX FIXTURES ARE CHOSEN SO THAT NO TWO OF THEM COINCIDE. Six statuses,
// six distinct step indices — a table whose rows shared an index would be a fixed
// point of the mutation it exists to catch. The `completed` row goes further: it
// carries a STALE `stage = 'ready'` (CS-T1 §10, reachable through lock → ready →
// complete), so it renders step 5 only while `stageIndex()` reads `status` first.
// A stage-first read lights step 4 there instead, and nothing else in this file
// would notice.
// ─────────────────────────────────────────────────────────────────────────────

const CS3_VIEW = join(CS2_FRONTEND_SRC, 'views/CycleDetail.vue')

async function loginAsAdminUI(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

async function adoptBrowserToken(page) {
  const token = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(token, 'the browser is logged in').toBeTruthy()
  adminToken = token
}

/** Log in through the UI and hand the API half the browser's token. */
async function adminUI(page) {
  await loginAsAdminUI(page)
  await adoptBrowserToken(page)
}

/** The six dots as `'done' | 'now' | 'next'`, in order. */
async function dotStates(page) {
  const strip = page.locator('[data-testid="cycle-timeline-compact"]')
  const dots = strip.locator('.d')
  await expect(dots, 'the compact strip renders all six steps').toHaveCount(6)
  // ⚠ ADDED AT THE MODULE-17 CLOSEOUT (CS-T4 review, 2026-09-20). §UC-CS-006's
  // acceptance says „exactly 6 `.d` and 5 `.ln`" and the connector half was pinned
  // NOWHERE — `grep '\.ln'` over this file returned nothing. Dropping the
  // `v-if="i < items.length - 1"` on `CycleTimeline.vue`'s connector renders SIX
  // connectors and the entire suite stayed green. An acceptance criterion the module
  // was about to close without.
  await expect(strip.locator('.ln'), 'five connectors between six dots — never six').toHaveCount(5)
  return dots.evaluateAll((els) => els.map((el) => (
    el.classList.contains('now') ? 'now' : el.classList.contains('next') ? 'next' : 'done'
  )))
}

test.describe('CS-T3 · 17 §UC-CS-007 — the two planning dates on the settings card', () => {
  test('both dates save through the card and survive a reload', async ({ page }) => {
    await adminUI(page)
    const cycle = await makeCycle('T3Dates')
    await page.goto(`/admin/cycle/${cycle.id}`)

    await expect(page.getByTestId('cycle-opens-at'), 'an unset column is an empty control').toHaveValue('')
    await expect(page.getByTestId('cycle-closes-at')).toHaveValue('')

    // ⚠ `type="date"` emits ISO `YYYY-MM-DD`, which is byte-for-byte what the route
    // stores — the read-back below is the whole claim: no client parsing anywhere.
    await page.getByTestId('cycle-opens-at').fill('2026-10-05')
    await page.getByTestId('cycle-opens-at-save').click()
    await expect.poll(async () => (await readCycle(cycle.id)).opens_at,
      { message: 'the opening reaches the column' }).toBe('2026-10-05')

    // ⚠ WAIT FOR THE REFETCH BEFORE TOUCHING THE SIBLING FIELD — this is a real race
    // and it flaked 2 of 6 runs on a loaded box (FUP-T26, 2026-09-20). The poll above
    // reads the API DIRECTLY, so it goes green the moment the PATCH commits, while the
    // page's own `loadAll()` is still in flight. CS-T3 moved that refetch into `finally`
    // (so a REFUSED save snaps the control back), which means it always runs — and when
    // it lands after the `fill()` below it resets `closesAt` to the stored `''`, so the
    // next click legitimately sends `closes_at: null` and the read-back is null.
    // `opensAtSaving` clears only AFTER `await loadAll()`, so the button returning to
    // enabled is the app's own „refetch finished" signal. Do not replace this with a
    // timeout.
    await expect(page.getByTestId('cycle-opens-at-save'),
      'the opening save settled, including its refetch').toBeEnabled()

    await page.getByTestId('cycle-closes-at').fill('2026-10-12')
    await page.getByTestId('cycle-closes-at-save').click()
    await expect.poll(async () => (await readCycle(cycle.id)).closes_at,
      { message: 'the deadline reaches the column' }).toBe('2026-10-12')

    await page.reload()
    await expect(page.getByTestId('cycle-opens-at')).toHaveValue('2026-10-05')
    await expect(page.getByTestId('cycle-closes-at')).toHaveValue('2026-10-12')

    // The two dates are INDEPENDENT of the shipped `expected_date`, which PO O2 made
    // the DELIVERY expectation — neither save may touch it or the plan note.
    const row = await readCycle(cycle.id)
    expect({ expected_date: row.expected_date, plan_note: row.plan_note })
      .toEqual({ expected_date: null, plan_note: null })
  })

  test('⚠ a refused pair shows the server message and the control SNAPS BACK', async ({ page }) => {
    await adminUI(page)
    const cycle = await makeCycle('T3Refuse', { opens_at: '2026-10-05' })
    await page.goto(`/admin/cycle/${cycle.id}`)
    await expect(page.getByTestId('cycle-opens-at')).toHaveValue('2026-10-05')

    await page.getByTestId('cycle-closes-at').fill('2026-10-01')
    await page.getByTestId('cycle-closes-at-save').click()

    // The server's own sentence, unrewritten by the client.
    await expect(page.getByText('Uzávierka nemôže byť pred otvorením')).toBeVisible()
    // ⚠ THE SNAP-BACK (CLAUDE.md §Frontend). The refused value is gone from the
    // control, which is back at the STORED one — the refetch runs on the failure
    // path too, and `loadAll()` does not clear the banner that explains why.
    await expect(page.getByTestId('cycle-closes-at'), 'the refused value does not stand').toHaveValue('')
    expect(stageTriple(await readCycle(cycle.id)), 'and nothing was written')
      .toEqual({ opens_at: '2026-10-05', closes_at: null, stage: null })

    // ⚠ NON-VACUITY: a LEGAL deadline on the very same control saves and sticks, so
    // the empty value above is a revert and not a control that refuses every edit.
    await page.getByTestId('cycle-closes-at').fill('2026-10-20')
    await page.getByTestId('cycle-closes-at-save').click()
    await expect(page.getByTestId('cycle-closes-at')).toHaveValue('2026-10-20')
    expect((await readCycle(cycle.id)).closes_at).toBe('2026-10-20')
  })

  test('an emptied control CLEARS the column', async ({ page }) => {
    await adminUI(page)
    const cycle = await makeCycle('T3Clear', { opens_at: '2026-10-05', closes_at: '2026-10-12' })
    await page.goto(`/admin/cycle/${cycle.id}`)
    await expect(page.getByTestId('cycle-opens-at')).toHaveValue('2026-10-05')

    await page.getByTestId('cycle-opens-at').fill('')
    await page.getByTestId('cycle-opens-at-save').click()
    await expect.poll(async () => (await readCycle(cycle.id)).opens_at).toBe(null)
    // ⚠ NON-VACUITY: the OTHER date is untouched, so „cleared" is one column and not
    // a save that wipes the card.
    expect((await readCycle(cycle.id)).closes_at).toBe('2026-10-12')
    await page.reload()
    await expect(page.getByTestId('cycle-opens-at')).toHaveValue('')
    await expect(page.getByTestId('cycle-closes-at')).toHaveValue('2026-10-12')
  })
})

test.describe('CS-T3 · 17 §UC-CS-007 — the forward-only stage buttons and the badge', () => {
  test('the two buttons walk the badge forward and then disappear', async ({ page }) => {
    await adminUI(page)
    const cycle = await makeCycle('T3Stage')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    await page.goto(`/admin/cycle/${cycle.id}`)

    // The admin reads exactly what the friend reads — the label comes from the lib's
    // `STEPS`, never from a second copy on this screen.
    await expect(page.getByTestId('cycle-stage-badge'))
      .toHaveText('Objednávky uzavreté, káva objednaná v pražiarni')
    await expect(page.getByTestId('cycle-stage-arrived')).toBeVisible()
    await expect(page.getByTestId('cycle-stage-ready')).toBeVisible()

    await page.getByTestId('cycle-stage-arrived').click()
    await expect(page.getByTestId('cycle-stage-badge')).toHaveText('Káva dorazila, balíme')
    await expect(page.getByTestId('cycle-stage-arrived'), 'forward-only: it hides itself').toHaveCount(0)
    await expect(page.getByTestId('cycle-stage-ready'), 'the next move is still offered').toBeVisible()
    expect((await readCycle(cycle.id)).stage).toBe('arrived')

    await page.getByTestId('cycle-stage-ready').click()
    await expect(page.getByTestId('cycle-stage-badge')).toHaveText('Zabalené, rozvážame')
    await expect(page.getByTestId('cycle-stage-arrived')).toHaveCount(0)
    await expect(page.getByTestId('cycle-stage-ready'), 'after `ready`: badge only').toHaveCount(0)
    expect((await readCycle(cycle.id)).stage).toBe('ready')
    // ⚠ The stage move writes NO status: „Ukončiť objednávku" stays the only way to
    // `completed` (CLAUDE.md §Money & data, §UC-CS-003).
    expect((await readCycle(cycle.id)).status).toBe('locked')
  })

  test('„Zabalené, rozvážame" may be used WITHOUT the arrival step', async ({ page }) => {
    await adminUI(page)
    const cycle = await makeCycle('T3Skip')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    await page.goto(`/admin/cycle/${cycle.id}`)

    await page.getByTestId('cycle-stage-ready').click()
    await expect(page.getByTestId('cycle-stage-badge')).toHaveText('Zabalené, rozvážame')
    await expect(page.getByTestId('cycle-stage-arrived')).toHaveCount(0)
    await expect(page.getByTestId('cycle-stage-ready')).toHaveCount(0)
    expect((await readCycle(cycle.id)).stage).toBe('ready')
  })

  test('a PRE-MODULE locked round (`stage IS NULL`) offers both buttons and reads as `ordered`', async ({ page }) => {
    test.skip(!DB_PATH, 'needs DB_PATH: this manufactures the pre-module row rather than relying on another rule')
    await adminUI(page)
    const cycle = await makeCycle('T3NullStage')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    // The state every locked round in production is in — the no-backfill rule
    // (§UC-CS-001) leaves them at NULL. ⚠ Since FUP-T26 a `planned → locked` PATCH
    // reaches it too; written directly anyway, so this stays evidence about the
    // PRE-MODULE row and not about that transition.
    withDb((db) => db.prepare('UPDATE order_cycles SET stage = NULL WHERE id = ?').run(cycle.id))
    expect((await readCycle(cycle.id)).stage, 'the fixture really is NULL').toBe(null)

    await page.goto(`/admin/cycle/${cycle.id}`)
    await expect(page.getByTestId('cycle-stage-badge'))
      .toHaveText('Objednávky uzavreté, káva objednaná v pražiarni')
    await expect(page.getByTestId('cycle-stage-arrived'), 'NULL is „not started", not „past it"').toBeVisible()
    await expect(page.getByTestId('cycle-stage-ready')).toBeVisible()
  })

  test('an OPEN cycle offers no stage badge and no stage buttons — the 409 is unreachable from the UI', async ({ page }) => {
    await adminUI(page)
    const cycle = await makeCycle('T3Open')
    await page.goto(`/admin/cycle/${cycle.id}`)

    // ⚠ NON-VACUITY: the header DID render, so the three absences below are about
    // the status and not about a page that failed to load.
    await expect(page.getByTestId('cycle-stage-timeline')).toBeVisible()
    await expect(page.getByTestId('cycle-stage-badge')).toHaveCount(0)
    await expect(page.getByTestId('cycle-stage-arrived')).toHaveCount(0)
    await expect(page.getByTestId('cycle-stage-ready')).toHaveCount(0)
    expect((await readCycle(cycle.id)).stage).toBe(null)
  })

  test('the badge and the timeline caption are ONE label, rendered twice', async ({ page }) => {
    await adminUI(page)
    const cycle = await makeCycle('T3OneLabel')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(cycle.id, { stage: 'arrived' })).status()).toBe(200)
    await page.goto(`/admin/cycle/${cycle.id}`)

    await expect(page.getByTestId('cycle-stage-badge')).toHaveText('Káva dorazila, balíme')
    await expect(page.getByTestId('cycle-stage-caption')).toHaveText('Káva dorazila, balíme')
  })
})

test.describe('CS-T3 · 17 §UC-CS-007 / §UC-CS-009 — the header timeline, RENDERED', () => {
  test('⚠ the `now` dot sits at `stageIndex` for all six steps, and no two fixtures share one', async ({ page }) => {
    await adminUI(page)

    const planned = await makeCycle('T3Ix0', { status: 'planned' })
    const open = await makeCycle('T3Ix1')
    const ordered = await makeCycle('T3Ix2')
    expect((await patchCycle(ordered.id, { status: 'locked' })).status()).toBe(200)
    const arrived = await makeCycle('T3Ix3')
    expect((await patchCycle(arrived.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(arrived.id, { stage: 'arrived' })).status()).toBe(200)
    const ready = await makeCycle('T3Ix4')
    expect((await patchCycle(ready.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(ready.id, { stage: 'ready' })).status()).toBe(200)
    // ⚠ THE DISCRIMINATOR. `completed` keeps the stage it finished on (§UC-CS-002:
    // it is the historical record), so this row's `stage` is a STALE `'ready'`. It
    // renders step 5 only because `stageIndex()` reads `status` first; a stage-first
    // read lights step 4 instead, and every other row in this table is a fixed point
    // of that mutation.
    const completed = await makeCycle('T3Ix5')
    expect((await patchCycle(completed.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(completed.id, { stage: 'ready' })).status()).toBe(200)
    expect((await patchCycle(completed.id, { status: 'completed' })).status()).toBe(200)
    const completedRow = await readCycle(completed.id)
    expect({ status: completedRow.status, stage: completedRow.stage },
      'the fixture really does carry a stale stage').toEqual({ status: 'completed', stage: 'ready' })

    const table = [
      [planned, 0, 'planned'],
      [open, 1, 'open'],
      [ordered, 2, 'locked + ordered'],
      [arrived, 3, 'locked + arrived'],
      [ready, 4, 'locked + ready'],
      [completed, 5, 'completed, stage still `ready`'],
    ]
    // Six fixtures, six DIFFERENT indices — nothing here is proved by coincidence.
    expect(new Set(table.map(([, i]) => i)).size).toBe(6)

    for (const [cycle, index, label] of table) {
      await page.goto(`/admin/cycle/${cycle.id}`)
      const states = await dotStates(page)
      expect(states, `${label} ⇒ step ${index}`).toEqual(
        Array.from({ length: 6 }, (_, i) => (i < index ? 'done' : i === index ? 'now' : 'next')),
      )
      // §UC-CS-009 item 1's rendered counts, stated as counts rather than inferred
      // from the array above.
      expect(states.filter((s) => s === 'done'), `${label}: done count`).toHaveLength(index)
      expect(states.filter((s) => s === 'now'), `${label}: exactly one current step`).toHaveLength(1)
      expect(states.filter((s) => s === 'next'), `${label}: next count`).toHaveLength(5 - index)
    }

    // Said once more, alone, so the failure message names the defect: on the
    // completed round step 4 is BEHIND the friend, not where they are.
    await page.goto(`/admin/cycle/${completed.id}`)
    const finished = await dotStates(page)
    expect(finished[4], 'a stage-first read would light step 4 here').toBe('done')
    expect(finished[5], 'and `completed` is the last step, whatever the stale stage says').toBe('now')
  })

  test('⚠ the timeline styles itself with NO `.app` ancestor — that is what the token fallbacks buy', async ({ page }) => {
    await adminUI(page)
    const cycle = await makeCycle('T3Skin')
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    await page.goto(`/admin/cycle/${cycle.id}`)
    const strip = page.locator('[data-testid="cycle-timeline-compact"]')
    await expect(strip).toBeVisible()

    // ⚠ THE PRECONDITION, ASSERTED RATHER THAN ASSUMED. Without these two lines the
    // computed values below would be just as green on a page that DID supply the
    // portal's tokens, and the claim would be about nothing.
    expect(await page.locator('.app, .modal-layer').count(),
      'the admin page carries neither skin root').toBe(0)
    expect(await page.evaluate(() => ['--nb-ink', '--accent', '--ink-dim']
      .map((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim())),
    'and the admin skin defines none of the portal tokens').toEqual(['', '', ''])

    // …so every number below comes from the FALLBACK in the component's own scoped
    // CSS. Drop one and the declaration is invalid at computed-value time: the
    // border collapses to `currentColor` (the plate's foreground — a different rgb)
    // and the accent background to transparent.
    //
    // ⚠ This is the compact variant's marker, `.d`. The vertical variant's `.mk`
    // carries the SAME `3px solid var(--nb-ink, …)` declaration but is not on this
    // screen: §UC-CS-007 mounts `variant="compact"` in the admin header, and the
    // first vertical mount is CS-T4's guest status card.
    const marker = strip.locator('.d').first()
    expect(await marker.evaluate((el) => {
      const cs = getComputedStyle(el)
      return `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`
    }), 'the ported marker border, resolved from its fallback').toBe('3px solid rgb(10, 10, 10)')

    const now = strip.locator('.d.now')
    await expect(now).toHaveCount(1)
    expect(await now.evaluate((el) => getComputedStyle(el).backgroundColor),
      'the accent fallback').toBe('rgb(255, 45, 135)')
    expect(await now.evaluate((el) => getComputedStyle(el).boxShadow),
      'and the ink fallback inside the shadow').toBe('rgb(10, 10, 10) 2px 2px 0px 0px')

    // The dot strip is a single `role="img"`, and its label has to name the step —
    // six identical squares say nothing to a screen reader.
    await expect(strip).toHaveAttribute('role', 'img')
    await expect(strip).toHaveAttribute('aria-label',
      'Krok 3 z 6: Objednávky uzavreté, káva objednaná v pražiarni')
  })

  test('the stage controls SHARE the header with DP-T8\'s plan line', async ({ page }) => {
    await adminUI(page)
    const cycle = await makeCycle('T3Header')
    const product = await addProduct(cycle.id)
    const friend = await makeFriend('Hdr')
    await ownOrder(friend, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await patchCycle(cycle.id, { status: 'locked' })).status()).toBe(200)
    await page.goto(`/admin/cycle/${cycle.id}`)

    const planLine = page.getByTestId('cycle-plan-line')
    await expect(planLine, '16 §UC-DP-014\'s line is still there').toBeVisible()
    const before = ((await planLine.textContent()) || '').replace(/\s+/g, ' ').trim()
    expect(before, 'and it still says something').not.toBe('')

    // Beside it, not instead of it.
    await expect(page.getByTestId('cycle-stage-badge')).toBeVisible()
    await expect(page.getByTestId('cycle-stage-timeline')).toBeVisible()

    // ⚠ A stage move re-reads the whole page; the plan sentence must come back
    // BYTE-IDENTICAL, because nothing on this screen re-derives its numbers — they
    // are the server's `plan[]` / `totals` through `lib/distribution-plan.js`.
    await page.getByTestId('cycle-stage-arrived').click()
    await expect(page.getByTestId('cycle-stage-badge')).toHaveText('Káva dorazila, balíme')
    await expect(planLine).toHaveText(before)
  })
})

test.describe('CS-T3 · 17 §UC-CS-007 — the admin skin is untouched', () => {
  test.skip(!CS2_HAS_SRC, CS2_NEEDS_SRC)

  test('⚠ the view passes `cycle`, never a `steps` array of its own', () => {
    const src = readFileSync(CS3_VIEW, 'utf8')
    // The component's optional `steps` prop is module 18's seam. A consumer that
    // builds its own array owns the `state` field — which is how stage-first
    // ordering, the defect this whole module guards against, gets back on a screen.
    expect(src, 'the cycle goes in whole; the component derives the steps')
      .toMatch(/<CycleTimeline\s+:cycle="cycle"\s+variant="compact"\s*\/>/)
    expect(src, 'no hand-built step array on this surface').not.toMatch(/:steps=/)
  })

  test('no `neo/` component, no theme token, no `.app` wrapper in the admin view', () => {
    const src = readFileSync(CS3_VIEW, 'utf8')
    expect(src).not.toMatch(/components\/neo\//)
    expect(src).not.toMatch(/friends-theme/)
    // A `class` attribute whose whitespace-separated tokens include a bare `app`.
    expect(src, 'the portal skin root never wraps an admin view')
      .not.toMatch(/class="(?:[^"]*\s)?app(?:\s[^"]*)?"/)
    expect(src).not.toMatch(/modal-layer/)
    // ⚠ NON-VACUITY: the one styled island IS mounted, so the four absences above
    // are about the skin and not about a view that renders no timeline.
    expect(src).toContain("import CycleTimeline from '@/components/CycleTimeline.vue'")
    // …and the labels still come from the one home, not from a copy typed here.
    expect(src).toMatch(/import \{ STEPS, stageIndex \} from '\.\.\/lib\/cycle-stages\.js'/)
    for (const label of ['Pripravujeme ďalšiu objednávku', 'Káva dorazila, balíme', 'Objednávka ukončená']) {
      expect(src, `„${label}" must live only in lib/cycle-stages.js`).not.toContain(label)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 13. CS-T4 · §UC-CS-008 — the guest status page mounts the VERTICAL timeline
//
// The module's closeout row, and the first `variant="vertical"` render anywhere
// (CS-T3 mounted the COMPACT strip in the admin header).
//
// ⚠⚠ WHAT IS DELIBERATELY NOT ASSERTED HERE, AND WHY. The obvious test on this
// page is `getComputedStyle('.mk').borderTopColor === 'rgb(10, 10, 10)'` — §UC-CS-009
// item 1 asks for exactly that, and CS-T3 could only deliver it on the compact
// variant's `.d`. IT CANNOT FAIL ON THIS PAGE. `GuestOrderStatus.vue`'s root is
// `<div class="app …">`, and `friends-theme.css` defines `--nb-ink:#0a0a0a` on
// `.app` — BYTE-IDENTICAL to the component's own fallback. Delete every `, #0a0a0a`
// in the SFC and that assertion still reads `rgb(10, 10, 10)`, because the token is
// genuinely supplied here. CS-T3's `.d` measurement on the admin page (which defines
// none of the portal tokens) is module 17's ONLY runtime proof of the fallback
// mechanism; per-declaration fallback COVERAGE is CS-T2's source gate above (the
// `bare` array must be `[]`). §UC-CS-009 was amended to say so, and this row pins
// what IS real on this page instead: the vertical variant's done/now/next COUNTS,
// its `now` LABEL, and the `when` line — none of which the `.app` ancestor can fake.
//
// ⚠ THE TWO STAGE FIXTURES DIFFER BY ONE STEP ON PURPOSE. `locked+ready` (index 4)
// and `locked+arrived` (index 3) produce different state vectors, different `now`
// keys and different labels, so a component that rendered a FIXED index — or a page
// that passed a stale/ignored `cycle` — cannot satisfy both. A single fixture would
// have been a fixed point of exactly that mutation.
// ─────────────────────────────────────────────────────────────────────────────

const CS4_VIEW = join(CS2_FRONTEND_SRC, 'views/GuestOrderStatus.vue')

let cs4Seq = 0

/** A cycle + product + host + share link + one submitted guest sub-order on it. */
async function guestScenario(label, over = {}) {
  const n = ++cs4Seq
  const cycle = await makeCycle(label, over)
  const product = await addProduct(cycle.id)
  const host = await makeFriend(`${label}H`)
  await ownOrder(host, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
  const link = await shareLink(host, cycle.id)
  const guest = await submitGuest(link.token, `CS4 Hostka ${uniq}${n}`, '0901234567',
    [{ product_id: product.id, variant: '250g', quantity: 2 }])
  return { cycle, product, host, link, guest, url: `/g/o/${guest.order_token}` }
}

/**
 * The vertical timeline's six rows, in order.
 *
 * ⚠ `textContent`, never `innerText`: `.st.now .lbl` and `.when` are
 * `text-transform: uppercase` in the port, and `innerText` APPLIES that (the
 * standing CLAUDE.md trap) — the labels would then have to be compared in a casing
 * the lib never produced, i.e. the assertion would be about this file's CSS.
 */
async function verticalSteps(page) {
  const steps = page.locator('[data-testid="cycle-timeline"] .st')
  await expect(steps, 'the vertical timeline renders all six steps').toHaveCount(6)
  return steps.evaluateAll((els) => els.map((el) => ({
    state: ['done', 'now', 'next'].find((c) => el.classList.contains(c)) || '',
    key: el.getAttribute('data-step'),
    label: (el.querySelector('.lbl')?.textContent || '').trim(),
    when: (el.querySelector('.when')?.textContent || '').trim(),
  })))
}

test.describe('CS-T4 · 17 §UC-CS-008 — „Kde je vaša káva" on the guest status page', () => {
  test('a locked+`ready` round: four done, „Zabalené, rozvážame" now, one next', async ({ page }) => {
    const fx = await guestScenario('T4Ready', { closes_at: '2026-10-10' })
    expect((await patchCycle(fx.cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(fx.cycle.id, { stage: 'ready' })).status()).toBe(200)

    await page.goto(fx.url)
    const card = page.getByTestId('guest-timeline-card')
    await expect(card).toBeVisible()
    // `textContent`, so the label reads as it is typed — `.field-lbl` is uppercased
    // by the theme and `toHaveText` resolves from `textContent`, not `innerText`.
    await expect(card.locator('.field-lbl')).toHaveText('Kde je vaša káva')

    const steps = await verticalSteps(page)
    expect(steps.map((s) => s.state), 'the whole state vector, not just a count')
      .toEqual(['done', 'done', 'done', 'done', 'now', 'next'])
    // …and the counts §UC-CS-008's acceptance criterion names, spelled out, so a
    // failure says which half moved.
    expect(steps.filter((s) => s.state === 'done')).toHaveLength(4)
    expect(steps.filter((s) => s.state === 'now')).toHaveLength(1)
    expect(steps.filter((s) => s.state === 'next')).toHaveLength(1)

    const now = steps.find((s) => s.state === 'now')
    expect(now.key, 'the round is at `ready`').toBe('ready')
    expect(now.label).toBe('Zabalené, rozvážame')

    // ⚠ NON-COINCIDENCE: six DISTINCT keys in the spec's order. A component that
    // rendered one step six times would satisfy every count above.
    expect(steps.map((s) => s.key))
      .toEqual(['planned', 'open', 'ordered', 'arrived', 'ready', 'completed'])

    // The pills are a DIFFERENT fact and they stay: `paid` is the admin's flag,
    // `delivered` the host's, both about THIS guest's bag. The timeline is the
    // round's state. Nothing here replaced anything.
    await expect(page.getByTestId('status-paid')).toBeVisible()
    await expect(page.getByTestId('status-delivered')).toBeVisible()

    // ⚠ CLAUDE.md `.app > *`: a direct child of the skin root computes
    // `position:relative; z-index:1` whatever it asked for. The card lives inside
    // the read-view wrapper, which is where every prototype placement puts it.
    expect(await page.locator('.app > [data-testid="guest-timeline-card"]').count(),
      'never a direct child of `.app`').toBe(0)
    expect(await page.locator('[data-testid="guest-status"] [data-testid="guest-timeline-card"]').count(),
      'it sits inside the read view').toBe(1)
  })

  test('a locked+`arrived` round lights the step BEFORE it — three done, two next', async ({ page }) => {
    const fx = await guestScenario('T4Arrived', { closes_at: '2026-10-10' })
    expect((await patchCycle(fx.cycle.id, { status: 'locked' })).status()).toBe(200)
    expect((await patchCycle(fx.cycle.id, { stage: 'arrived' })).status()).toBe(200)

    await page.goto(fx.url)
    await expect(page.getByTestId('guest-timeline-card')).toBeVisible()

    const steps = await verticalSteps(page)
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'now', 'next', 'next'])
    expect(steps.filter((s) => s.state === 'done')).toHaveLength(3)
    expect(steps.filter((s) => s.state === 'next')).toHaveLength(2)
    expect(steps[3].key).toBe('arrived')
    expect(steps[3].label).toBe('Káva dorazila, balíme')

    // Steps 3-5 have no timestamp to print (resolved conflict 8) — the deadline
    // lines belong to 0-2 only, and `when` does not depend on `state`.
    expect(steps.slice(3).map((s) => s.when), 'no invented „when" on the later steps')
      .toEqual(['', '', ''])
    expect(steps[2].when, 'the deadline still prints on a closed round').toBe('10. októbra')
  })

  test('the OPEN state renders too, and the DEADLINE reaches the DOM from `closes_at`', async ({ page }) => {
    const fx = await guestScenario('T4Open', { closes_at: '2026-10-10' })

    await page.goto(fx.url)
    await expect(page.getByTestId('guest-timeline-card'),
      '„useful while they can still edit" — §UC-CS-008').toBeVisible()

    const steps = await verticalSteps(page)
    expect(steps.map((s) => s.state)).toEqual(['done', 'now', 'next', 'next', 'next', 'next'])
    expect(steps[1].label).toBe('Objednávky otvorené')
    // ⚠ THE FIELD THAT PROVES THE WIRING. `status`/`stage` alone could come from a
    // default; this line exists only if the cycle OBJECT the guest payload publishes
    // reached the component — §UC-CS-004's `closes_at`, formatted by the lib.
    expect(steps[1].when).toBe('do 10. októbra')
    expect(steps[2].when).toBe('10. októbra')
  })

  test('EDIT MODE hides the card, and leaving restores it', async ({ page }) => {
    const fx = await guestScenario('T4Edit', { closes_at: '2026-10-10' })

    await page.goto(fx.url)
    await expect(page.getByTestId('guest-timeline-card'), 'the gate: it is there to begin with').toBeVisible()

    await page.getByTestId('start-edit').click()
    await expect(page.getByTestId('save-edit'), 'really in edit mode').toBeVisible()
    await expect(page.getByTestId('guest-timeline-card'), 'the cart has the screen').toHaveCount(0)
    await expect(page.locator('[data-testid="cycle-timeline"]'),
      'and no stray timeline anywhere else on the page').toHaveCount(0)

    await page.getByTestId('abort-edit').click()
    await expect(page.getByTestId('guest-timeline-card')).toBeVisible()
  })

  test('a CANCELLED sub-order has no coffee to locate — the card is gone', async ({ page }) => {
    const fx = await guestScenario('T4Cancel', { closes_at: '2026-10-10' })

    await page.goto(fx.url)
    await expect(page.getByTestId('guest-timeline-card'), 'the gate: present while the bag lives').toBeVisible()

    // The destructive edit the module-14 contract requires: a LITERAL empty array.
    const cancelled = await ctx.put(`/api/guest/${fx.link.token}/orders/${fx.guest.order_token}`, {
      data: { items: [] }, timeout: TIMEOUT,
    })
    expect(cancelled.status(), 'guest cancel').toBe(200)

    await page.reload()
    await expect(page.getByTestId('guest-status'), 'the page still renders').toBeVisible()
    await expect(page.getByTestId('status-cancelled'), 'the danger banner carries that state').toBeVisible()
    await expect(page.getByTestId('guest-timeline-card')).toHaveCount(0)
  })

  test('⚠ the read-only banner drops „cykle", and the whole page says neither „kolo" nor „cyklus"', async ({ page }) => {
    const fx = await guestScenario('T4Copy', { closes_at: '2026-10-10' })
    expect((await patchCycle(fx.cycle.id, { status: 'locked' })).status()).toBe(200)

    await page.goto(fx.url)
    const banner = page.getByTestId('status-readonly')
    await expect(banner).toBeVisible()
    // The retarget of `guest-status-shell.spec.js:356` (§UC-CS-009 item 5): the
    // sentence keeps its job, only its vocabulary moved.
    await expect(banner).toHaveText('Objednávky sú uzavreté, objednávku už nie je možné upraviť.')

    const copy = await page.evaluate(collectAppCopy())
    // ⚠ NON-VACUITY, TWICE OVER — an absence assertion over an empty sweep passes
    // for the wrong reason. The sweep must have seen the retargeted sentence AND a
    // step label off the mounted timeline (step 5 is `next`, so it is not one of the
    // uppercased rows `innerText` would re-case).
    expect(copy, 'the sweep saw the read-only banner')
      .toContain('Objednávky sú uzavreté, objednávku už nie je možné upraviť.')
    expect(copy, 'the sweep saw the timeline it is supposed to be sweeping')
      .toContain('Objednávka ukončená')
    await expect(page.getByTestId('guest-timeline-card')).toBeVisible()

    const offenders = copy.split('\n').filter((line) => BANNED.test(line))
    expect(offenders, 'no guest-facing string on this page may say „kolo" or „cyklus"').toEqual([])
  })
})

test.describe('CS-T4 · 17 §UC-CS-008 — the guest surface keeps its own skin', () => {
  test.skip(!CS2_HAS_SRC, CS2_NEEDS_SRC)

  test('⚠ the view passes `cycle`, never a `steps` array of its own', () => {
    const src = readFileSync(CS4_VIEW, 'utf8')
    // Same rule as CS-T3's admin mount, and the same reason: `steps` is module 18's
    // desc-injection seam, and a consumer that builds its own array owns the `state`
    // field — which is where stage-before-status ordering gets back onto a screen.
    expect(src, 'the cycle goes in whole; the component derives the steps')
      .toMatch(/<CycleTimeline\s+:cycle="cycle"\s*\/>/)
    expect(src, 'no hand-built step array on this surface').not.toMatch(/:steps=/)
    expect(src).toContain("import CycleTimeline from '@/components/CycleTimeline.vue'")
  })

  test('the six labels are still typed in exactly one place', () => {
    const src = readFileSync(CS4_VIEW, 'utf8')
    for (const label of ['Pripravujeme ďalšiu objednávku', 'Objednávky otvorené',
      'Káva dorazila, balíme', 'Zabalené, rozvážame', 'Objednávka ukončená']) {
      expect(src, `„${label}" must live only in lib/cycle-stages.js`).not.toContain(label)
    }
    // …and the retargeted sentence is here, once, so the two absences above are not
    // about a view that renders nothing.
    expect(src).toContain('Objednávky sú uzavreté, objednávku už nie je možné upraviť.')
    expect(src, 'the superseded wording is gone from the app').not.toContain('Objednávanie v tomto cykle je uzavreté')
  })
})
