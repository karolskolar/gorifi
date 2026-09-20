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
//   4. **The stub is a no-op.** `markCycleReady()` returns `null`, moves no row, and
//      is the module's ONLY export — CS-T1 replaces that one symbol.
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

// ─── 3. helpers/cycle-stage.js — UC-DP-009 stub ──────────────────────────────

const STUB_PROBE = [
  "const db = (await import(process.env.SCHEMA_URL)).default",
  "const mod = await import(process.env.CYCLE_STAGE_URL)",
  "db.run(\"INSERT INTO order_cycles (name, status) VALUES ('DP-T1 stub', 'locked')\")",
  "const cycle = db.get(\"SELECT * FROM order_cycles WHERE name = 'DP-T1 stub' ORDER BY id DESC\")",
  "const tables = db.all(\"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'\").map((r) => r.name)",
  "const counts = () => Object.fromEntries(tables.map((t) => [t, db.get('SELECT COUNT(*) AS n FROM \"' + t + '\"').n]))",
  "const before = counts()",
  "const returned = [mod.markCycleReady(cycle.id), mod.markCycleReady(cycle.id), mod.markCycleReady(), mod.markCycleReady('abc'), mod.markCycleReady(null), mod.markCycleReady({})]",
  "const after = counts()",
  "const cycleAfter = db.get('SELECT * FROM order_cycles WHERE id = ?', [cycle.id])",
  "process.stdout.write('\\nDP_T1_RESULT:' + JSON.stringify({",
  "  returned, before, after, cycleBefore: cycle, cycleAfter, exports: Object.keys(mod).sort(),",
  "}) + '\\n')",
]

test.describe('DP-T1 · 16 §UC-DP-009 markCycleReady() stub', () => {
  test.skip(!CAN_IMPORT_SOURCE, NEEDS_SOURCE)

  let probe = null

  test.beforeAll(async () => {
    const dbPath = tmpDbPath('stub')
    try {
      probe = await runProbe('cycle-stage', STUB_PROBE, dbPath)
    } finally {
      removeDb(dbPath)
    }
  })

  test('is the module\'s only export — CS-T1 replaces that one symbol', () => {
    expect(probe.exports).toEqual(['markCycleReady'])
  })

  test('returns null for every argument shape and writes nothing', () => {
    expect(probe.returned, 'every call answers null').toEqual([null, null, null, null, null, null])
    expect(probe.after, 'no row created or deleted, in any table').toEqual(probe.before)
    expect(probe.cycleAfter, 'the cycle row is byte-identical').toEqual(probe.cycleBefore)
    expect(probe.cycleAfter.status, 'status is never touched by this module').toBe('locked')
  })

  test('contains no SQL at all — the body is module 17\'s (CS-T1)', () => {
    const source = fs.readFileSync(CYCLE_STAGE_ENTRY, 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code, 'no UPDATE').not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i)
    expect(code, 'no INSERT').not.toMatch(/\bINSERT\s+INTO\b/i)
    expect(source, 'the successor is named at the site').toMatch(/CS-T1|17-cycle-stages/)
  })
})

// ─── 4. the live server: publication + an outbox nobody writes ───────────────

test.describe('DP-T1 · handed_over_at is published, notifications stays empty', () => {
  let ctx = null
  let adminToken = ''
  let fixture = null

  const admin = (method, url, data) =>
    ctx[method](url, { headers: { 'X-Admin-Token': adminToken }, ...(data ? { data } : {}) })

  function notificationCount() {
    if (!DB_PATH) return null
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n)
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

    fixture = { friend, cycle, hostAuth, guestOrder: await guestRes.json() }
  })

  test.afterAll(async () => { await ctx?.dispose() })

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

  test('nothing in the app writes a notifications row', async () => {
    // ⚠ RECORDED LIMIT, for the row that lands the first writer (DP-T3): this test
    // can only pass while NO writer exists at all — the load-bearing evidence today
    // is the repo-wide absence of any `INSERT INTO notifications`, not this burst.
    // Once the hand-over routes ship, REWRITE it as "only those routes write":
    // hand over a bag, assert the expected `queued` rows appear (UC-DP-008's
    // counts/columns), and assert the burst below still adds none. Left as-is it
    // degrades into a tautology that passes whatever DP-T3 does.
    test.skip(!DB_PATH, 'needs DB_PATH pointed at the server database (the documented skip)')
    const before = notificationCount()
    expect(before, 'the outbox starts empty — DP-T3 is the first writer').toBe(0)

    // A burst of real traffic over the surfaces this row touched.
    expect((await admin('get', `/api/cycles/${fixture.cycle.id}/distribution`)).status()).toBe(200)
    expect((await ctx.get(`/api/guest-links/cycle/${fixture.cycle.id}`, { headers: fixture.hostAuth })).status()).toBe(200)
    expect((await admin('get', `/api/guest-orders/cycle/${fixture.cycle.id}/unpaid`)).status()).toBe(200)
    expect((await admin('patch', `/api/guest-orders/${fixture.guestOrder.order.id}/paid`, { paid: true })).status()).toBe(200)
    expect((await admin('patch', `/api/cycles/${fixture.cycle.id}`, { status: 'locked' })).status()).toBe(200)

    expect(notificationCount(), 'still empty after the burst').toBe(0)
  })
})
