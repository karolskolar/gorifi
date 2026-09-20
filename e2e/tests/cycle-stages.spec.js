import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'

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
//  4. ⚠ **A LOCKED CYCLE WITH `stage IS NULL` IS UNREACHABLE THROUGH THE API** —
//     locking writes `ordered`, unlocking writes NULL *and* opens the cycle, and
//     the PATCH refuses `stage: null`. But it is the state EVERY locked cycle in
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

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

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
  // Unreachable through the API (locking writes `ordered`, unlocking also opens the
  // cycle, and `stage: null` is a 400), so the fixture writes it directly.
  test('a PRE-MODULE locked cycle (`stage IS NULL`) is promoted to `ready`', async () => {
    test.skip(!DB_PATH, 'needs DB_PATH: a locked cycle with stage IS NULL cannot be built through the API')
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
