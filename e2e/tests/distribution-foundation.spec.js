import { test, expect, request as playwrightRequest } from '@playwright/test'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'

// DP-T1 — module 16 (distribution pipeline), the foundation row:
// 16 §UC-DP-001 (`helpers/delivery.js`), §UC-DP-002 (schema) and §UC-DP-009 (the
// `markCycleReady()` stub). Nothing user-visible ships here, so the bar is the one
// the row itself states:
//
//   1. **The migration really MIGRATES.** `orders.handed_over_at` and
//      `guest_orders.handed_over_at` are in the CREATE *and* in a try/catch ALTER,
//      because both tables exist in prod. A CREATE-only change passes every test on
//      a fresh file and ships a broken deploy, so the evidence here is a database
//      that ALREADY EXISTS and does NOT have the column: the shipped
//      `e2e/fixtures/prod-template.sqlite` (a scrubbed copy of production, which
//      predates this row), plus a self-built case that STRIPS the column back off a
//      migrated file and boots again — that second one can never go vacuous, whatever
//      a future template rebuild contains.
//   2. **`notifications` is declared and nothing writes it.** DP-T3 is the first
//      writer; module 21 owns every later column and must add them with its own
//      ALTERs rather than re-declaring the CREATE. So: the table exists with the
//      01-architecture column list, and its row count stays 0 across a burst of real
//      app traffic.
//   3. **`helpers/delivery.js` classifies, and only classifies.** Every case
//      UC-DP-001's table lists, including the hostile guest-address shapes
//      (`undefined`, a number, `'   '`, an inherited property) — driven against the
//      REAL module in a throwaway `node`, the `payment-links.spec.js` /
//      `catalog-foundation.spec.js` idiom, because `undefined` and a
//      prototype-only property cannot survive JSON. Plus the read-only pin:
//      `helpers/pickup.js` stays the SOLE WRITER of the pickup / Packeta / fee
//      columns, so this helper's source may not contain a write at all.
//   4. ~~**The stub is a no-op.** `markCycleReady()` returns `null`, moves no row, and
//      is the module's ONLY export — CS-T1 replaces that one symbol.~~ **SUPERSEDED BY
//      CS-T1 (2026-09-20), as that sentence promised.** Section 3 below now pins the
//      SHIPPED seam: three exports (`CYCLE_STAGES`, `LOCKED_STAGE_DEFAULT`,
//      `markCycleReady`), a first call answering `{ changed: true, stage: 'ready' }`
//      and a second `{ changed: false, stage: 'ready' }`. What did NOT change is what
//      the bullet was really protecting and what this file still proves at the SQL:
//      it moves no row in ANY table, and it touches `stage` and nothing else — the
//      `SET` clause is read and pinned verbatim.
//   5. **`GUEST_ORDER_FIELDS` publishes `handed_over_at`** on the surfaces the shared
//      list feeds (the host's guest-links view and the admin distribution payload).
//
// ⚠ The child probes get a THROWAWAY `DB_PATH`, never the gate server's file:
// importing any helper boots `db/schema.js`, which opens and migrates whatever
// `DB_PATH` names (e2e/README.md's per-run rule, applied to the child).

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(E2E_DIR, '..')
const BACKEND_ENTRY = path.resolve(REPO_ROOT, 'backend/src/index.js')
const SCHEMA_ENTRY = path.resolve(REPO_ROOT, 'backend/src/db/schema.js')
const DELIVERY_ENTRY = path.resolve(REPO_ROOT, 'backend/src/helpers/delivery.js')
const CYCLE_STAGE_ENTRY = path.resolve(REPO_ROOT, 'backend/src/helpers/cycle-stage.js')
const TEMPLATE_DB = path.resolve(E2E_DIR, 'fixtures/prod-template.sqlite')

const CAN_IMPORT_SOURCE = fs.existsSync(BACKEND_ENTRY)
const NEEDS_SOURCE = 'needs the backend source beside e2e/ (skipped against a deployment)'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const DB_PATH = process.env.DB_PATH || ''

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// The 01-architecture §Roadmap column list, in order. The CREATE is required to be
// this list VERBATIM — module 21 grows it with ALTERs of its own.
const NOTIFICATION_COLUMNS = [
  'id', 'channel', 'template_key', 'segment_key', 'recipient_kind', 'recipient_id',
  'phone_e164', 'body', 'status', 'cycle_id', 'order_id', 'guest_order_id',
  'created_at', 'released_at', 'sent_at', 'error',
]

// ─── child-process plumbing ──────────────────────────────────────────────────

function tmpDbPath(label) {
  return path.join(os.tmpdir(), `gorifi-dp-t1-${label}-${uniq}-${Math.floor(Math.random() * 1e6)}.sqlite`)
}

function removeDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix, { force: true }) } catch { /* best effort */ }
  }
}

/**
 * Run an ESM snippet in a throwaway `node` against `dbPath` and parse the single
 * `DP_T1_RESULT:` line it prints. Any non-zero exit (a missing module, a throwing
 * helper) is a LOUD failure, never a skip.
 */
async function runProbe(label, lines, dbPath, extraEnv = {}) {
  const script = lines.join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      DB_PATH: dbPath,
      SCHEMA_URL: pathToFileURL(SCHEMA_ENTRY).href,
      DELIVERY_URL: pathToFileURL(DELIVERY_ENTRY).href,
      CYCLE_STAGE_URL: pathToFileURL(CYCLE_STAGE_ENTRY).href,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', (c) => { output += c })
  child.stderr.on('data', (c) => { output += c })
  const exitCode = await new Promise((resolve) => child.on('exit', resolve))

  const match = output.match(/DP_T1_RESULT:(.*)/)
  if (exitCode !== 0 || !match) {
    throw new Error(`probe "${label}" failed (exit ${exitCode}):\n${output}`)
  }
  return JSON.parse(match[1])
}

/** Boot `db/schema.js` once against `dbPath` — i.e. what a backend restart does. */
async function bootSchema(dbPath) {
  return runProbe('boot-schema', [
    'await import(process.env.SCHEMA_URL)',
    "process.stdout.write('\\nDP_T1_RESULT:' + JSON.stringify({ booted: true }) + '\\n')",
  ], dbPath)
}

function readSchemaShape(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    const notificationsSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'")
      .get()
    return {
      orders: columns('orders'),
      guest_orders: columns('guest_orders'),
      hasNotifications: !!notificationsSql,
      notificationColumns: notificationsSql ? columns('notifications') : [],
      notificationsSql: notificationsSql ? String(notificationsSql.sql) : '',
      notificationIndexes: db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notifications' AND sql IS NOT NULL")
        .all()
        .map((r) => r.name),
    }
  } finally {
    db.close()
  }
}

// ─── 1. schema: the ALTER, not just the CREATE ───────────────────────────────

test.describe('DP-T1 · 16 §UC-DP-002 schema', () => {
  test.skip(!CAN_IMPORT_SOURCE, NEEDS_SOURCE)

  test('the columns are ADDED to a database that already existed (strip-and-reboot)', async () => {
    // ⚠ This case cannot go vacuous. It builds a migrated database, then takes the
    // three new objects BACK OFF it with `DROP COLUMN` / `DROP TABLE` — which is
    // exactly the state every deployed database is in — and boots again. Only the
    // try/catch ALTERs can put them back; `CREATE TABLE IF NOT EXISTS orders` is a
    // no-op on a table that exists.
    const dbPath = tmpDbPath('strip')
    try {
      await bootSchema(dbPath)
      const fresh = readSchemaShape(dbPath)
      expect(fresh.orders, 'CREATE carries orders.handed_over_at').toContain('handed_over_at')
      expect(fresh.guest_orders, 'CREATE carries guest_orders.handed_over_at').toContain('handed_over_at')
      expect(fresh.hasNotifications, 'CREATE declares notifications').toBe(true)

      const db = new DatabaseSync(dbPath)
      db.exec('ALTER TABLE orders DROP COLUMN handed_over_at')
      db.exec('ALTER TABLE guest_orders DROP COLUMN handed_over_at')
      db.exec('DROP TABLE notifications')
      db.close()

      const stripped = readSchemaShape(dbPath)
      expect(stripped.orders, 'non-vacuity: the column really is gone').not.toContain('handed_over_at')
      expect(stripped.guest_orders, 'non-vacuity: the guest column really is gone').not.toContain('handed_over_at')
      expect(stripped.hasNotifications, 'non-vacuity: the table really is gone').toBe(false)

      await bootSchema(dbPath)
      const migrated = readSchemaShape(dbPath)
      expect(migrated.orders, 'ALTER re-adds orders.handed_over_at').toContain('handed_over_at')
      expect(migrated.guest_orders, 'ALTER re-adds guest_orders.handed_over_at').toContain('handed_over_at')
      expect(migrated.hasNotifications, 'CREATE IF NOT EXISTS re-declares notifications').toBe(true)

      // And a second boot on the same file is a no-op, not a crash (§UC-DP-002).
      await bootSchema(dbPath)
      const again = readSchemaShape(dbPath)
      expect(again.orders.filter((c) => c === 'handed_over_at').length, 'idempotent ALTER').toBe(1)
      expect(again.guest_orders.filter((c) => c === 'handed_over_at').length, 'idempotent ALTER').toBe(1)
    } finally {
      removeDb(dbPath)
    }
  })

  test('a copy of the PRODUCTION template gains both columns on boot', async () => {
    test.skip(!fs.existsSync(TEMPLATE_DB), 'no e2e/fixtures/prod-template.sqlite on this box')
    const dbPath = tmpDbPath('template')
    try {
      fs.copyFileSync(TEMPLATE_DB, dbPath)
      const before = readSchemaShape(dbPath)
      // ⚠ The evidence, and the non-vacuity gate: the shipped template is a scrubbed
      // production database built BEFORE this row. If a future `make-test-db.sh` run
      // rebuilds it from a prod DB that already carries the column, this line is the
      // one to relax — the strip-and-reboot case above keeps the proof either way.
      expect(before.orders, 'template predates orders.handed_over_at').not.toContain('handed_over_at')
      expect(before.guest_orders, 'template predates guest_orders.handed_over_at').not.toContain('handed_over_at')
      expect(before.hasNotifications, 'template predates notifications').toBe(false)

      await bootSchema(dbPath)

      const after = readSchemaShape(dbPath)
      expect(after.orders, 'migrated orders.handed_over_at').toContain('handed_over_at')
      expect(after.guest_orders, 'migrated guest_orders.handed_over_at').toContain('handed_over_at')
      expect(after.hasNotifications, 'notifications created on an existing DB').toBe(true)
      expect(after.notificationColumns, 'the 01-architecture column list, verbatim and in order')
        .toEqual(NOTIFICATION_COLUMNS)
    } finally {
      removeDb(dbPath)
    }
  })

  test('the notifications CREATE carries the three CHECK lists and no index', async () => {
    const dbPath = tmpDbPath('notif')
    try {
      await bootSchema(dbPath)
      const shape = readSchemaShape(dbPath)
      expect(shape.notificationColumns).toEqual(NOTIFICATION_COLUMNS)
      const sql = shape.notificationsSql.replace(/\s+/g, ' ')
      expect(sql, 'channel CHECK').toContain("channel IN ('whatsapp','email')")
      expect(sql, 'recipient_kind CHECK').toContain("recipient_kind IN ('friend','guest','waitlist')")
      expect(sql, 'status CHECK').toContain("status IN ('queued','released','sent','failed','skipped')")
      // `body` / `phone_e164` are NULLABLE — UC-DP-008 writes them as NULL.
      const db = new DatabaseSync(dbPath)
      try {
        db.exec(
          "INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, recipient_id, " +
          "phone_e164, body, status, cycle_id, order_id, guest_order_id) " +
          "VALUES ('whatsapp', 'pickup', 'loc1', 'friend', 1, NULL, NULL, 'queued', 1, 1, NULL)"
        )
        const row = db.prepare('SELECT * FROM notifications').get()
        expect(row.body, 'body nullable').toBe(null)
        expect(row.phone_e164, 'phone_e164 nullable').toBe(null)
        expect(row.created_at, 'created_at defaulted').toBeTruthy()
        // and the CHECKs bite
        expect(() => db.exec(
          "INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, status) " +
          "VALUES ('sms', 'pickup', 'loc1', 'friend', 'queued')"
        ), 'channel CHECK refuses sms').toThrow()
        expect(() => db.exec(
          "INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, status) " +
          "VALUES ('whatsapp', 'pickup', 'loc1', 'friend', 'delivered')"
        ), 'status CHECK refuses an unknown state').toThrow()
      } finally {
        db.close()
      }
      // §UC-DP-002: "No index is required by this module; module 21 may add one."
      expect(shape.notificationIndexes, 'no index ships with DP-T1').toEqual([])
    } finally {
      removeDb(dbPath)
    }
  })
})

// ─── 2. helpers/delivery.js — UC-DP-001 ──────────────────────────────────────

const DELIVERY_PROBE = [
  "const db = (await import(process.env.SCHEMA_URL)).default",
  "const mod = await import(process.env.DELIVERY_URL)",
  // A SOFT-DELETED pickup point: the name lookup must ignore `active = 1`
  // (helpers/pickup.js `pickupOf()` rule), or a perfectly well defined party goes
  // nameless on the board.
  "db.run(\"INSERT INTO pickup_locations (name, address, active) VALUES ('Kaviaren Ruza', 'Ruzova 1', 0)\")",
  "const loc = db.get(\"SELECT id FROM pickup_locations WHERE name = 'Kaviaren Ruza'\")",
  "const locId = Number(loc.id)",
  // A location the helper must NOT have to query for: the payload pre-resolves.
  "const prefetched = new Map([[locId, { id: locId, name: 'Z mapy', address: 'Mapova 2' }]])",
  "const d = (party, opts) => mod.deliveryOf(party, opts)",
  "const hostPickup = d({ pickup_location_id: locId })",
  "const hostPacketa = d({ packeta_address: 'Z-BOX Ruzinov', phone: '0901 111 222' })",
  "const hostInPerson = d({ pickup_location_note: 'u mna v praci' })",
  "const cases = {",
  "  friend_packeta_wins: d({ packeta_address: 'Z-BOX Ruzinov', pickup_location_id: locId, pickup_location_note: 'pri brane', phone: '0901 111 222' }),",
  "  friend_pickup_inactive: d({ pickup_location_id: locId, phone: '0902 000 000' }),",
  "  friend_pickup_prefetched: d({ pickup_location_id: locId }, { locationsById: prefetched }),",
  "  friend_pickup_unknown_id: d({ pickup_location_id: 987654 }),",
  "  friend_in_person_note: d({ pickup_location_note: 'u mna v praci', phone: '0903 000 000' }),",
  "  friend_in_person_bare: d({}),",
  "  friend_packeta_blank: d({ packeta_address: '   ', pickup_location_id: locId }),",
  "  friend_packeta_empty: d({ packeta_address: '', pickup_location_note: 'pri brane' }),",
  "  friend_packeta_number: d({ packeta_address: 42 }),",
  "  friend_packeta_true: d({ packeta_address: true }),",
  "  friend_packeta_null: d({ packeta_address: null }),",
  "  friend_packeta_object: d({ packeta_address: { toString: null } }),",
  "  friend_packeta_array: d({ packeta_address: ['Z-BOX'] }),",
  "  friend_packeta_inherited: d(Object.create({ packeta_address: 'Z-BOX zdedeny' })),",
  "  friend_pickup_zero: d({ pickup_location_id: 0 }),",
  "  friend_pickup_negative: d({ pickup_location_id: -3 }),",
  "  friend_pickup_float: d({ pickup_location_id: 2.5 }),",
  "  friend_pickup_nan: d({ pickup_location_id: NaN }),",
  "  friend_pickup_string: d({ pickup_location_id: String(locId) }),",
  "  friend_pickup_inherited: d(Object.create({ pickup_location_id: locId })),",
  "  party_null: d(null),",
  "  party_undefined: d(),",
  "  party_string: d('kaviaren'),",
  "  guest_via_pickup_host: d({ link_id: 7, guest_phone: '0911 000 001', host_name: 'Karol' }, { host: hostPickup }),",
  "  guest_via_packeta_host: d({ link_id: 7, guest_phone: '0911 000 002', host_name: 'Karol' }, { host: hostPacketa }),",
  "  guest_via_in_person_host: d({ link_id: 7, guest_phone: '0911 000 003', host_name: 'Karol' }, { host: hostInPerson }),",
  "  guest_via_host_no_name: d({ link_id: 7, guest_phone: '0911 000 004' }, { host: hostPickup }),",
  "  guest_own_packeta: d({ link_id: 7, packeta_address: 'Z-BOX Nivy', guest_phone: '0911 000 005', host_name: 'Karol' }, { host: hostPickup }),",
  "  guest_packeta_number: d({ link_id: 7, packeta_address: 1234, guest_phone: '0911 000 006', host_name: 'Karol' }, { host: hostPickup }),",
  "  guest_packeta_inherited: d(Object.assign(Object.create({ packeta_address: 'Z-BOX zdedeny' }), { link_id: 7, guest_phone: '0911 000 007', host_name: 'Karol' }), { host: hostPickup }),",
  // A GUEST ROW (own `link_id`) whose host is missing or unusable: it must stay
  // `via_host` — never a standalone, independently hand-over-able bag.
  "  guest_no_host: d({ link_id: 7, guest_phone: '0911 000 008', host_name: 'Karol' }),",
  "  guest_host_garbage: d({ link_id: 7, guest_phone: '0911 000 009', host_name: 'Karol' }, { host: {} }),",
  "  guest_host_string: d({ link_id: 7, guest_phone: '0911 000 010', host_name: 'Karol' }, { host: 'packeta' }),",
  "  guest_host_bogus_key: d({ link_id: 7, guest_phone: '0911 000 011', host_name: 'Karol' }, { host: { target_key: 'loc0', target_label: 'Nikde' } }),",
  "  guest_link_id_inherited: d(Object.assign(Object.create({ link_id: 7 }), { guest_phone: '0911 000 012' })),",
  "  guest_link_id_string: d({ link_id: '7', guest_phone: '0911 000 013' }),",
  // A FRIEND party has no `link_id` — the guard must not swallow it.
  "  friend_with_garbage_host: d({ pickup_location_id: locId, phone: '0912 000 001' }, { host: {} }),",
  "}",
  "const groupOrders = {",
  "  ordered: mod.deliveryGroupOrder([{ id: 3 }, { id: 1 }, { id: 2 }]),",
  "  empty: mod.deliveryGroupOrder([]),",
  "  missing: mod.deliveryGroupOrder(),",
  "  nullish: mod.deliveryGroupOrder(null),",
  "  notArray: mod.deliveryGroupOrder('kaviaren'),",
  "  duplicates: mod.deliveryGroupOrder([{ id: 1 }, { id: 1 }, { id: 2 }]),",
  "  hostile: mod.deliveryGroupOrder([null, { id: 0 }, { id: '2' }, { id: 2.5 }, {}, { id: 7 }]),",
  "}",
  "process.stdout.write('\\nDP_T1_RESULT:' + JSON.stringify({",
  "  locId, cases, groupOrders, labels: mod.TARGET_LABELS, exports: Object.keys(mod).sort(),",
  "}) + '\\n')",
]

test.describe('DP-T1 · 16 §UC-DP-001 helpers/delivery.js', () => {
  test.skip(!CAN_IMPORT_SOURCE, NEEDS_SOURCE)

  let probe = null
  let locId = 0

  test.beforeAll(async () => {
    const dbPath = tmpDbPath('delivery')
    try {
      probe = await runProbe('delivery', DELIVERY_PROBE, dbPath)
      locId = probe.locId
    } finally {
      removeDb(dbPath)
    }
  })

  test('exports exactly the three UC-DP-001 symbols', () => {
    expect(probe.exports).toEqual(['TARGET_LABELS', 'deliveryGroupOrder', 'deliveryOf'])
    expect(probe.labels, 'the only two literals').toEqual({ packeta: 'Packeta', in_person: 'Osobne' })
  })

  test('a friend party classifies by the UC-DP-001 table, address first', () => {
    // Packeta wins over a pickup point (mirrors the exclusive-by-construction write).
    expect(probe.cases.friend_packeta_wins).toEqual({
      type: 'packeta', target_key: 'packeta', target_label: 'Packeta',
      target_detail: 'Z-BOX Ruzinov', phone: '0901 111 222',
    })
    // A SOFT-DELETED location still names itself, and a pickup party carries no phone.
    expect(probe.cases.friend_pickup_inactive).toEqual({
      type: 'pickup', target_key: `loc${locId}`, target_label: 'Kaviaren Ruza',
      target_detail: 'Ruzova 1', phone: null,
    })
    // Pre-resolved locations short-circuit the query (UC-DP-003's N+1 escape).
    expect(probe.cases.friend_pickup_prefetched.target_label).toBe('Z mapy')
    expect(probe.cases.friend_pickup_prefetched.target_detail).toBe('Mapova 2')
    expect(probe.cases.friend_in_person_note).toEqual({
      type: 'in_person', target_key: 'in_person', target_label: 'Osobne',
      target_detail: 'u mna v praci', phone: null,
    })
    expect(probe.cases.friend_in_person_bare).toEqual({
      type: 'in_person', target_key: 'in_person', target_label: 'Osobne',
      target_detail: null, phone: null,
    })
  })

  test('a hostile or absent packeta_address is never a Packeta bag', () => {
    // '   ' and '' are "no Packeta" — the party falls through to its pickup columns.
    expect(probe.cases.friend_packeta_blank.target_key).toBe(`loc${locId}`)
    expect(probe.cases.friend_packeta_empty).toMatchObject({ type: 'in_person', target_detail: 'pri brane' })
    for (const key of [
      'friend_packeta_number', 'friend_packeta_true', 'friend_packeta_null',
      'friend_packeta_object', 'friend_packeta_array', 'friend_packeta_inherited',
    ]) {
      expect(probe.cases[key], `${key} must not classify as packeta`).toMatchObject({
        type: 'in_person', target_key: 'in_person',
      })
    }
  })

  test('pickup_location_id is a POSITIVE INTEGER or it is not a pickup', () => {
    for (const key of [
      'friend_pickup_zero', 'friend_pickup_negative', 'friend_pickup_float',
      'friend_pickup_nan', 'friend_pickup_string', 'friend_pickup_inherited',
    ]) {
      expect(probe.cases[key], `${key} fails closed to in_person`).toMatchObject({
        type: 'in_person', target_key: 'in_person', target_label: 'Osobne',
      })
    }
    // A dangling id keeps its key (the party's pickup IS defined) but has no name.
    expect(probe.cases.friend_pickup_unknown_id).toEqual({
      type: 'pickup', target_key: 'loc987654', target_label: null, target_detail: null, phone: null,
    })
  })

  test('an unbindable party is classified, never thrown at', () => {
    for (const key of ['party_null', 'party_undefined', 'party_string']) {
      expect(probe.cases[key], key).toEqual({
        type: 'in_person', target_key: 'in_person', target_label: 'Osobne',
        target_detail: null, phone: null,
      })
    }
  })

  test('a guest without its own address inherits the host — with its OWN phone', () => {
    expect(probe.cases.guest_via_pickup_host).toEqual({
      type: 'via_host', target_key: `loc${locId}`, target_label: 'Kaviaren Ruza',
      target_detail: 'cez Karol', phone: '0911 000 001',
    })
    expect(probe.cases.guest_via_packeta_host).toMatchObject({
      type: 'via_host', target_key: 'packeta', target_label: 'Packeta',
      target_detail: 'cez Karol', phone: '0911 000 002',
    })
    expect(probe.cases.guest_via_in_person_host).toMatchObject({
      type: 'via_host', target_key: 'in_person', target_label: 'Osobne', phone: '0911 000 003',
    })
    expect(probe.cases.guest_via_host_no_name.target_detail, 'no host name to render').toBe(null)
    // module 20's column, already classified: the guest is its own Packeta party.
    expect(probe.cases.guest_own_packeta).toEqual({
      type: 'packeta', target_key: 'packeta', target_label: 'Packeta',
      target_detail: 'Z-BOX Nivy', phone: '0911 000 005',
    })
    // …and the hostile shapes of that same column stay `via_host`.
    expect(probe.cases.guest_packeta_number).toMatchObject({ type: 'via_host', target_key: `loc${locId}` })
    expect(probe.cases.guest_packeta_inherited, 'own-property only (the variantGrams discipline)')
      .toMatchObject({ type: 'via_host', target_key: `loc${locId}` })
  })

  test('a guest with no usable host FAILS CLOSED — via_host, never a standalone bag', () => {
    // ⚠ The permissive answer would be `in_person`, i.e. its own collection — and a
    // standalone party is one DP-T5 renders as its own bag and DP-T3 lets an admin
    // hand over independently. §UC-DP-001 grants that to exactly ONE kind of guest
    // (module 20's, with its own `packeta_address`), so a guest whose host is
    // missing or garbage stays `via_host` and is parked on the `in_person` group.
    for (const key of ['guest_no_host', 'guest_host_garbage', 'guest_host_string', 'guest_host_bogus_key']) {
      expect(probe.cases[key], key).toMatchObject({
        type: 'via_host', target_key: 'in_person', target_label: 'Osobne', target_detail: 'cez Karol',
      })
      expect(probe.cases[key].type, `${key} is never a standalone bag`).not.toBe('in_person')
    }
    // The guest marker is `guest_orders.link_id`, read own-property + type-safe like
    // everything else here: an inherited or string-typed one is not a guest row.
    expect(probe.cases.guest_link_id_inherited).toMatchObject({ type: 'in_person', target_key: 'in_person' })
    expect(probe.cases.guest_link_id_string).toMatchObject({ type: 'in_person', target_key: 'in_person' })
    // …and a FRIEND party (no `link_id`) is untouched by the guard, whatever junk
    // arrives in `host`.
    expect(probe.cases.friend_with_garbage_host).toMatchObject({ type: 'pickup', target_key: `loc${locId}` })
  })

  test('deliveryGroupOrder is packeta → locations by ascending id → in_person', () => {
    expect(probe.groupOrders.ordered).toEqual(['packeta', 'loc1', 'loc2', 'loc3', 'in_person'])
    expect(probe.groupOrders.empty).toEqual(['packeta', 'in_person'])
    expect(probe.groupOrders.missing).toEqual(['packeta', 'in_person'])
    expect(probe.groupOrders.nullish).toEqual(['packeta', 'in_person'])
    expect(probe.groupOrders.notArray).toEqual(['packeta', 'in_person'])
    expect(probe.groupOrders.duplicates).toEqual(['packeta', 'loc1', 'loc2', 'in_person'])
    expect(probe.groupOrders.hostile).toEqual(['packeta', 'loc7', 'in_person'])
  })

  test('the helper READS — helpers/pickup.js stays the sole writer', () => {
    const source = fs.readFileSync(DELIVERY_ENTRY, 'utf8')
    // Strip comments so the prose about writing does not fail its own rule.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const verb of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i]) {
      expect(code, `delivery.js must contain no ${verb}`).not.toMatch(verb)
    }
    expect(code, 'never a second pickup writer').not.toContain('applyPickup')
    expect(code, 'never a second store chooser').not.toContain('pickupTargetFor')
  })
})

// ─── 3. helpers/cycle-stage.js — the UC-DP-009 seam ──────────────────────────
//
// ⚠ ~~This section pinned DP-T1's NO-OP STUB: one export, a `null` return for every
// argument shape, and not one line of SQL in the file.~~ **SUPERSEDED BY CS-T1
// (2026-09-20), exactly as all three of its test names promised** („CS-T1 replaces
// that one symbol", „the body is module 17's"). Module 17 shipped the body, so the
// stub assertions are retargeted here rather than deleted — a test that pins the
// ABSENCE of a feature stops being evidence the moment the feature lands, and
// leaving it red or deleting it silently both lose what it was really protecting.
//
// What it was really protecting, and what therefore survives VERBATIM below:
//   • `order_cycles.status` is NEVER touched by this module (no auto-complete);
//   • NOT ONE ROW is created or deleted in ANY table — the ledger-neutrality of the
//     hand-over, asserted where the SQL lives rather than through a route;
//   • the cycle row changes in `stage` AND NOTHING ELSE.
// What changes: the export list grows to module 17's three symbols, and the return
// is `{ changed, stage }` instead of `null`.
//
// ⚠ The stub accepted `undefined` / `{}` because it bound nothing. The real helper
// binds, so those two shapes now THROW — deliberately not guarded: all three call
// sites pass a `cycle_id` read from a database row, and swallowing a malformed id
// would silently skip a promotion instead of failing loudly. The probe below keeps
// the shapes a caller can actually produce (an unknown id, `null`), which must be a
// safe no-op.

const SEAM_PROBE = [
  "const db = (await import(process.env.SCHEMA_URL)).default",
  "const mod = await import(process.env.CYCLE_STAGE_URL)",
  "db.run(\"INSERT INTO order_cycles (name, status) VALUES ('CS-T1 seam', 'locked')\")",
  "const cycle = db.get(\"SELECT * FROM order_cycles WHERE name = 'CS-T1 seam' ORDER BY id DESC\")",
  "const tables = db.all(\"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'\").map((r) => r.name)",
  "const counts = () => Object.fromEntries(tables.map((t) => [t, db.get('SELECT COUNT(*) AS n FROM \"' + t + '\"').n]))",
  "const before = counts()",
  "const first = mod.markCycleReady(cycle.id)",
  "const second = mod.markCycleReady(cycle.id)",
  "const unknown = [mod.markCycleReady(987654321), mod.markCycleReady('abc'), mod.markCycleReady(null)]",
  "const after = counts()",
  "const cycleAfter = db.get('SELECT * FROM order_cycles WHERE id = ?', [cycle.id])",
  "process.stdout.write('\\nDP_T1_RESULT:' + JSON.stringify({",
  "  first, second, unknown, before, after, cycleBefore: cycle, cycleAfter,",
  "  stages: mod.CYCLE_STAGES, lockedDefault: mod.LOCKED_STAGE_DEFAULT,",
  "  exports: Object.keys(mod).sort(),",
  "}) + '\\n')",
]

test.describe('CS-T1 · 17 §UC-CS-003 markCycleReady() — the seam, at the SQL', () => {
  test.skip(!CAN_IMPORT_SOURCE, NEEDS_SOURCE)

  let probe = null

  test.beforeAll(async () => {
    const dbPath = tmpDbPath('seam')
    try {
      probe = await runProbe('cycle-stage', SEAM_PROBE, dbPath)
    } finally {
      removeDb(dbPath)
    }
  })

  test('the module exports the enum, the lock default and the one transition', () => {
    expect(probe.exports).toEqual(['CYCLE_STAGES', 'LOCKED_STAGE_DEFAULT', 'markCycleReady'])
    expect(probe.stages, 'the ONE home for the three values').toEqual(['ordered', 'arrived', 'ready'])
    expect(probe.lockedDefault).toBe('ordered')
  })

  test('promotes a locked cycle ONCE, and the second call changes nothing', () => {
    expect(probe.first, 'first hand-over').toEqual({ changed: true, stage: 'ready' })
    expect(probe.second, 'idempotent — the value, not the change').toEqual({ changed: false, stage: 'ready' })
  })

  test('an id that resolves to no row is a safe no-op', () => {
    expect(probe.unknown, 'never a throw, never a write').toEqual([
      { changed: false, stage: null },
      { changed: false, stage: null },
      { changed: false, stage: null },
    ])
  })

  test('writes NOT ONE row in any table, and touches nothing but `stage`', () => {
    expect(probe.after, 'no row created or deleted, in any table').toEqual(probe.before)
    expect(probe.cycleAfter.status, '⚠ status is never touched by this module').toBe('locked')
    expect(probe.cycleBefore.stage, 'the fixture is the pre-module NULL row').toBe(null)
    expect(probe.cycleAfter, 'stage, and nothing else')
      .toEqual({ ...probe.cycleBefore, stage: 'ready' })
  })

  test('the file contains exactly ONE UPDATE and no INSERT/DELETE', () => {
    const source = fs.readFileSync(CYCLE_STAGE_ENTRY, 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code.match(/\bUPDATE\s+\w+/gi) || [], 'one transition, one statement').toHaveLength(1)
    expect(code, 'no INSERT').not.toMatch(/\bINSERT\s+INTO\b/i)
    expect(code, 'no DELETE — hand-over is ledger-neutral').not.toMatch(/\bDELETE\s+FROM\b/i)
    // ⚠ NOT a `/SET[\s\S]{0,80}status\s*=/` proximity regex — the real statement has
    // `AND status = 'locked'` in its WHERE, ~30 characters after the SET, so that
    // form reds on correct code. The claim is about the ASSIGNMENT LIST: read the
    // whole SET clause and pin it, so `SET stage = 'ready', status = 'completed'`
    // cannot slip past.
    const setClauses = code.match(/\bSET\b[\s\S]*?\bWHERE\b/gi) || []
    expect(setClauses, 'one UPDATE, one SET clause').toHaveLength(1)
    expect(setClauses[0].replace(/\s+/g, ' ').trim(), '⚠ `stage` is the only column ever assigned')
      .toBe("SET stage = 'ready' WHERE")
  })
})

// ─── 4. the live server: publication + an outbox nobody writes ───────────────

test.describe('DP-T1 · handed_over_at is published, notifications stays empty', () => {
  let ctx = null
  let adminToken = ''
  let fixture = null

  const admin = (method, url, data) =>
    ctx[method](url, { headers: { 'X-Admin-Token': adminToken }, ...(data ? { data } : {}) })

  // ⚠ SCOPED TO THIS FIXTURE'S CYCLE since DP-T3. A GLOBAL count was right while
  // NOTHING wrote the table; now that the hand-over routes do, other spec files
  // legitimately leave `queued` rows behind, and a global claim would be a value
  // claim over rows this file does not own — the FUP-T17 lesson, applied before it
  // can bite. Every assertion below is about THIS cycle's outbox.
  function notificationRows(cycleId) {
    if (!DB_PATH) return null
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      return db.prepare(`
        SELECT id, channel, template_key, segment_key, recipient_kind, recipient_id,
               phone_e164, body, status, cycle_id, order_id, guest_order_id,
               released_at, sent_at, error
          FROM notifications WHERE cycle_id = ? ORDER BY id
      `).all(Number(cycleId))
    } finally {
      db.close()
    }
  }

  test.beforeAll(async () => {
    ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status(), 'admin login').toBe(200)
    adminToken = (await login.json()).token

    // host friend with a login (the share link is a host-authenticated route)
    const name = `DPT1 Host ${uniq}`
    const created = await admin('post', '/api/friends', { name })
    expect(created.status(), 'friend create').toBe(201)
    const friend = await created.json()
    const username = `dpt1_${uniq}`.slice(0, 30)
    expect((await admin('put', `/api/friends/${friend.id}/admin-username`, { username })).status()).toBe(200)
    expect((await admin('put', `/api/friends/${friend.id}/reset-password`, { password: 'initPass1' })).status()).toBe(200)
    const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
    expect(auth.status(), 'friend login').toBe(200)
    const authBody = await auth.json()
    const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
      headers: { Authorization: `Bearer ${authBody.token}` },
      data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
    })
    expect(chg.status(), 'forced change').toBe(200)
    const token = (await chg.json()).token || authBody.token

    const cycleRes = await admin('post', '/api/cycles', { name: `E2E DPT1 ${uniq}`, type: 'coffee', status: 'open' })
    expect(cycleRes.status(), 'cycle create').toBe(201)
    const cycle = await cycleRes.json()

    const productRes = await admin('post', '/api/products', {
      cycle_id: cycle.id, name: `DPT1 Kava ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé',
      price_250g: 10, price_1kg: 30,
    })
    expect(productRes.status(), 'product create').toBe(201)
    const product = await productRes.json()

    const hostAuth = { Authorization: `Bearer ${token}` }
    const linkRes = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: hostAuth })
    expect([200, 201]).toContain(linkRes.status())
    const link = (await linkRes.json()).link

    const guestRes = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        guest_name: `DPT1 Host'ka ${uniq}`, guest_phone: '0901 234 567',
        guest_email: `dpt1-${uniq}@example.test`,
        items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
      },
    })
    expect(guestRes.status(), 'guest submit').toBe(201)

    // ── DP-T3 additions: what the FIRST WRITER needs in order to be provable ──
    // §UC-DP-008's acceptance case is „a `pickup` friend with two live guests
    // inserts exactly three queued rows", so the fixture grows a second colleague
    // and the host grows an own order collected at a pickup point.
    const guest2Res = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        guest_name: `DPT1 Host'ka Dva ${uniq}`, guest_phone: '0902 345 678',
        items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
      },
    })
    expect(guest2Res.status(), 'second guest submit').toBe(201)

    // ⚠ `pickup_locations` is GLOBAL and every ACTIVE row becomes an <option> in the
    // picker every admin cycle row renders, so this one is retired in afterAll (the
    // cross-spec hygiene rule recorded in distribution-handover.spec.js).
    const locRes = await admin('post', '/api/pickup-locations', {
      name: `DPT1 Miesto ${uniq}`, address: 'Testovacia 1', for_coffee: true, for_bakery: true,
    })
    expect(locRes.status(), 'pickup location create').toBe(201)
    const location = await locRes.json()

    const cartRes = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
      headers: hostAuth, data: { items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
    })
    expect(cartRes.status(), 'host cart').toBe(200)
    const submitRes = await ctx.post(`/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, {
      headers: hostAuth, data: { pickup_location_id: location.id },
    })
    expect(submitRes.status(), 'host submit').toBe(200)

    fixture = {
      friend, cycle, hostAuth, location,
      order: (await submitRes.json()).order,
      guestOrder: await guestRes.json(),
      guestOrder2: await guest2Res.json(),
    }
  })

  test.afterAll(async () => {
    if (fixture?.location) {
      const res = await admin('delete', `/api/pickup-locations/${fixture.location.id}`)
      expect([204, 404], 'fixture location retired').toContain(res.status())
    }
    await ctx?.dispose()
  })

  test('the host view publishes handed_over_at through GUEST_ORDER_FIELDS', async () => {
    const res = await ctx.get(`/api/guest-links/cycle/${fixture.cycle.id}`, { headers: fixture.hostAuth })
    expect(res.status(), 'host guest-links view').toBe(200)
    const body = await res.json()
    expect(body.guest_orders.length, 'the fixture sub-order is there').toBeGreaterThan(0)
    const row = body.guest_orders[0]
    expect(Object.prototype.hasOwnProperty.call(row, 'handed_over_at'), 'the column is published').toBe(true)
    expect(row.handed_over_at, 'nothing has handed anything over yet').toBe(null)
    // additive, never a reshape: the shipped list survives intact
    for (const field of ['id', 'guest_name', 'status', 'total', 'paid', 'delivered', 'order_token']) {
      expect(Object.prototype.hasOwnProperty.call(row, field), `${field} still published`).toBe(true)
    }
  })

  test('the admin distribution payload publishes it on the nested guest rows', async () => {
    const res = await admin('get', `/api/cycles/${fixture.cycle.id}/distribution`)
    expect(res.status(), 'distribution').toBe(200)
    const party = (await res.json()).distribution.find((r) => r.id === fixture.friend.id)
    expect(party, 'the host is a party').toBeTruthy()
    expect(party.guest_orders.length).toBeGreaterThan(0)
    expect(
      Object.prototype.hasOwnProperty.call(party.guest_orders[0], 'handed_over_at'),
      'published on the admin surface too'
    ).toBe(true)
    expect(party.guest_orders[0].handed_over_at).toBe(null)
  })

  // ⚠ REWRITTEN BY DP-T3, per the note this test used to carry. It used to say
  // „nothing in the app writes a notifications row", which could only ever pass
  // while NO writer existed — the load-bearing evidence was the repo-wide absence
  // of any `INSERT INTO notifications`, not the burst. DP-T3 IS the first writer,
  // so the claim becomes the one that stays true: **ONLY the two hand-over routes
  // write, and this is exactly what they write.**
  //
  // ⚠ The `DB_PATH` skip stays here and ONLY here, for a reason that is not the one
  // the two retired `distribution-handover.spec.js` tests had: `notifications` has
  // no API at all, in this module or in 21's read-only direction, so the COLUMNS of
  // a queued row are unobservable without the file. The route BEHAVIOUR (how many
  // rows, and when none) is asserted ungated over there, through the
  // `queued_notifications` / `dequeued_notifications` counts the routes answer.
  test('only the hand-over routes write a notifications row — and these are the rows', async () => {
    test.skip(!DB_PATH, 'the outbox has no API — column-level evidence needs the database file')

    const cycleId = fixture.cycle.id
    expect(notificationRows(cycleId), 'this cycle\'s outbox starts empty').toEqual([])

    // 1. A burst of REAL traffic over every surface module 16 touched. None of it is
    //    a hand-over, so none of it may queue anything.
    expect((await admin('get', `/api/cycles/${cycleId}/distribution`)).status()).toBe(200)
    expect((await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: fixture.hostAuth })).status()).toBe(200)
    expect((await admin('get', `/api/guest-orders/cycle/${cycleId}/unpaid`)).status()).toBe(200)
    expect((await admin('patch', `/api/guest-orders/${fixture.guestOrder.order.id}/paid`, { paid: true })).status()).toBe(200)
    expect((await admin('patch', `/api/cycles/${cycleId}`, { status: 'locked' })).status()).toBe(200)

    expect(notificationRows(cycleId), 'ordinary traffic still adds none').toEqual([])

    // 2. Pack the bag. ⚠ Packing is STAGE 2 and is the LEDGER moment — it is also
    //    not a hand-over, so it queues nothing either. (No cycle-open gate: the
    //    cycle is `locked` by now, which is exactly when the admin packs.)
    const beforePack = await admin('get', `/api/cycles/${cycleId}/distribution`)
    const party = (await beforePack.json()).distribution.find((r) => r.id === fixture.friend.id)
    for (const item of party.items) {
      expect((await admin('patch', `/api/order-items/${item.id}/packed`)).status()).toBe(200)
    }
    for (const guest of party.guest_orders) {
      for (const item of guest.items) {
        expect((await admin('patch', `/api/guest-order-items/${item.id}/packed`)).status()).toBe(200)
      }
    }
    expect((await admin('patch', `/api/orders/${fixture.order.id}/packed`)).status()).toBe(200)
    expect(notificationRows(cycleId), 'packing is not a hand-over').toEqual([])

    // 3. THE hand-over. §UC-DP-008's acceptance case: a `pickup` friend with two
    //    live guests inserts exactly THREE `queued` rows.
    const handed = await admin('patch', `/api/orders/${fixture.order.id}/handed-over`, { handed_over: true })
    expect(handed.status()).toBe(200)
    expect((await handed.json()).queued_notifications).toBe(3)

    const rows = notificationRows(cycleId)
    expect(rows.length, 'one per (recipient, bag) — and not one more').toBe(3)

    for (const row of rows) {
      // ⚠ The fixed columns of §UC-DP-008. `body` and `phone_e164` are NULL ON
      // PURPOSE: module 21 renders the text and resolves the number at RELEASE
      // time, because the template is editable in its composer first — rendering
      // here would freeze stale wording into rows.
      expect(row.channel).toBe('whatsapp')
      expect(row.status, 'no `released` transition exists in module 16').toBe('queued')
      expect(row.body, 'facts, not text').toBe(null)
      expect(row.phone_e164, 'resolved by module 21 at release').toBe(null)
      expect(row.released_at).toBe(null)
      expect(row.sent_at).toBe(null)
      expect(row.error).toBe(null)
      expect(row.cycle_id).toBe(cycleId)
    }

    const friendRows = rows.filter((row) => row.recipient_kind === 'friend')
    expect(friendRows.length, 'one for the friend whose bag it is').toBe(1)
    expect(friendRows[0]).toMatchObject({
      template_key: 'pickup',
      segment_key: `loc${fixture.location.id}`,
      recipient_id: fixture.friend.id,
      order_id: fixture.order.id,
      guest_order_id: null,
    })

    const guestRows = rows.filter((row) => row.recipient_kind === 'guest')
    expect(guestRows.length, 'one per inherited colleague').toBe(2)
    expect(guestRows.map((row) => row.guest_order_id).sort((a, b) => a - b)).toEqual(
      [fixture.guestOrder.order.id, fixture.guestOrder2.order.id].sort((a, b) => a - b)
    )
    for (const row of guestRows) {
      expect(row.template_key, 'a guest travelling with their host hears about the HOST').toBe('host')
      expect(row.segment_key, 'grouped by host, not by where the host collects')
        .toBe(`host:${fixture.friend.id}`)
      expect(row.recipient_id, 'a guest recipient IS the sub-order').toBe(row.guest_order_id)
      expect(row.order_id).toBe(null)
    }

    // 4. A repeat inserts NONE — while the rows are still `queued`, the dedupe key
    //    is what stops it.
    const repeat = await admin('patch', `/api/orders/${fixture.order.id}/handed-over`, { handed_over: true })
    expect(repeat.status()).toBe(200)
    expect((await repeat.json()).queued_notifications).toBe(0)
    expect(notificationRows(cycleId).length, 'still three').toBe(3)

    // 5. ⚠ REVIEW FINDING (DP-T3), and the reason this file keeps a WRITE handle:
    //    the dedupe above only holds WHILE the rows are `queued`. Module 21 moves
    //    them to `released`/`sent` (WA-T5), and from that moment a dedupe-only
    //    guard would let a second `handed_over: true` on an ALREADY-handed bag mint
    //    a fresh full set — duplicate „your coffee is at X" messages to real people,
    //    for a request that changed no state at all. The rule that survives 21 is
    //    the one asserted here: a hand-over enqueues for the bags IT STAMPED, so a
    //    no-op call mints nothing whatever the old rows' status is.
    //
    //    Simulated by flipping this cycle's rows directly, because no route in
    //    module 16 can produce a non-`queued` row — those transitions are 21's.
    const flip = new DatabaseSync(DB_PATH)
    try {
      flip.prepare("UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE cycle_id = ? AND status = 'queued'")
        .run(cycleId)
    } finally {
      flip.close()
    }
    expect(notificationRows(cycleId).filter((row) => row.status === 'sent').length, 'all three are history now').toBe(3)

    const noopAfterSent = await admin('patch', `/api/orders/${fixture.order.id}/handed-over`, { handed_over: true })
    expect(noopAfterSent.status()).toBe(200)
    expect(
      (await noopAfterSent.json()).queued_notifications,
      'a hand-over that stamps nothing queues nothing — even with nothing left to dedupe against'
    ).toBe(0)
    expect(notificationRows(cycleId).length, 'not one duplicate message was minted').toBe(3)

    // 6. The reversal deletes `queued` rows ONLY — history is never deleted.
    const reversedOverSent = await admin('patch', `/api/orders/${fixture.order.id}/handed-over`, { handed_over: false })
    expect(reversedOverSent.status()).toBe(200)
    expect((await reversedOverSent.json()).dequeued_notifications, 'nothing is queued').toBe(0)
    const survivors = notificationRows(cycleId)
    expect(survivors.length, 'the sent rows survive the reversal').toBe(3)
    expect(survivors.every((row) => row.status === 'sent')).toBe(true)

    // 7. A GENUINE re-hand-over after that reversal IS a new event, so the `sent`
    //    rows do not block a new `queued` set.
    const again = await admin('patch', `/api/orders/${fixture.order.id}/handed-over`, { handed_over: true })
    expect(again.status()).toBe(200)
    expect(
      (await again.json()).queued_notifications,
      'a `sent` row does not block a new `queued` one — the bag really left again'
    ).toBe(3)

    const mixed = notificationRows(cycleId)
    expect(mixed.length, 'three sent plus three fresh queued').toBe(6)
    expect(mixed.filter((row) => row.status === 'sent').length).toBe(3)
    expect(mixed.filter((row) => row.status === 'queued').length).toBe(3)

    // 8. …and the reversal takes exactly the fresh three.
    const cleared = await admin('patch', `/api/orders/${fixture.order.id}/handed-over`, { handed_over: false })
    expect((await cleared.json()).dequeued_notifications).toBe(3)
    const finalRows = notificationRows(cycleId)
    expect(finalRows.length, 'history survives the dequeue').toBe(3)
    expect(finalRows.every((row) => row.status === 'sent')).toBe(true)

    // 9. ⚠ DP-T4 (§UC-DP-006): the BULK route is the SECOND writer of this table,
    //    and it inherits the review finding above rather than re-learning it. The
    //    dedupe on a `queued` row cannot prove the rule — with the old rows still
    //    `queued` an over-eager enqueue answers 0 anyway — so the pin is the same
    //    one: flip everything to `sent`, then re-send the SAME batch. Every id in it
    //    is already handed over, the call stamps nothing, and therefore it must mint
    //    nothing. This is the shape that reaches real people the day module 21 sends.
    const bulkPath = `/api/cycles/${cycleId}/distribution/hand-over`
    const bulkBody = { order_ids: [fixture.order.id], guest_order_ids: [] }

    const bulk = await admin('post', bulkPath, bulkBody)
    expect(bulk.status()).toBe(200)
    const bulkJson = await bulk.json()
    expect(bulkJson.handed_over, 'a genuine bulk hand-over of one party').toBe(1)
    expect(bulkJson.guests_inherited, 'its two live colleagues come with it').toBe(2)
    expect(bulkJson.queued_notifications, 'friend + two guests, as per bag').toBe(3)
    expect(notificationRows(cycleId).length, 'three sent plus the fresh three').toBe(6)

    const flipBulk = new DatabaseSync(DB_PATH)
    try {
      flipBulk.prepare("UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE cycle_id = ? AND status = 'queued'")
        .run(cycleId)
    } finally {
      flipBulk.close()
    }
    expect(notificationRows(cycleId).filter((row) => row.status === 'queued').length, 'nothing is queued now').toBe(0)

    const bulkRepeat = await admin('post', bulkPath, bulkBody)
    expect(bulkRepeat.status(), 'an idempotent re-run of a group is not a refusal').toBe(200)
    const repeatJson = await bulkRepeat.json()
    expect(repeatJson.handed_over).toBe(0)
    expect(repeatJson.already_handed, 'the bag is skipped, not refused').toBe(1)
    expect(repeatJson.guests_inherited).toBe(0)
    expect(
      repeatJson.queued_notifications,
      'a batch that stamps nothing queues nothing — even with nothing left to dedupe against'
    ).toBe(0)
    expect(notificationRows(cycleId).length, 'not one duplicate message was minted').toBe(6)
  })
})
