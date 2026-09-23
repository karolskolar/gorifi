// Module 20 — Packeta delivery for guests. Started by GP-T1 (20 §UC-GP-001 schema +
// shared lists + published cycle flags, §UC-GP-002 the submit contract, §UC-GP-004's
// SERVER half — `payment.amount = total + delivery_fee` + the confirmation-mail rows —
// and §UC-GP-006's cancel statement), plus the `delivery_fee_paid` snapshot of the
// orchestrator clarification (PO decisions 2026-09-19). GP-T2..T6 extend this file.
//
// API-level: GP-T1 ships no UI. Every money path READS THE ROW BACK through `withDb`
// (the response is not evidence of what was stored), every refusal reads the row
// count back, and the ledger pin is the FUP-T17 `MAX(transactions.id)` before/after
// idiom. Fixtures are per test, never a shared `beforeAll` (the GSO-T8 lesson).
//
// NOTE ON RATE LIMITS: run with the raised budgets (e2e/README.md) — every test here
// logs in as admin + host and submits through `guestWriteLimiter`.

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'
import { stripComments } from '../helpers/source-pins.js'
import { BANNED } from '../helpers/vocabulary.js'
import {
  withMailHarness, multipartFields, CAN_SPAWN_BACKEND, FAKE_MAILGUN_KEY, STUB_MAILGUN_DOMAIN,
} from '../mailgun-harness.js'

const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src')
const HAS_BACKEND_SRC = existsSync(join(BACKEND_SRC, 'db', 'schema.js'))
const NEEDS_BACKEND_SRC = 'needs the backend source beside e2e/ (skipped against a deployment)'
const srcUrl = (rel) => 'file://' + join(BACKEND_SRC, rel)
const readBackend = (rel) => readFileSync(join(BACKEND_SRC, rel), 'utf8')

// The server strings (20 §UC-GP-002). ⚠ DRAFT copy, PO sign-off on staging (PO
// 2026-09-19) — hoisted so sign-off is a known two-place edit (these + routes/guest.js).
const ERR_METHOD = 'Neplatný spôsob prevzatia'
const ERR_PARCEL_OFF = 'Doručenie Packetou nie je pre túto objednávku dostupné'
const ERR_ADDRESS_MISSING = 'Zadajte výdajné miesto Packety'
const ERR_ADDRESS_LONG = 'Výdajné miesto je príliš dlhé (najviac 160 znakov)'
const ERR_EMAIL_MISSING = 'Pri doručení Packetou zadajte e-mail'
const ERR_EMAIL_SHAPE = 'Neplatný e-mail'
// The confirmation-mail labels (20 §UC-GP-004) — mirrored in guest-order-recovery.spec.js.
const MAIL_DELIVERY_LABEL = 'Doručenie Packetou'
const MAIL_PACKETA_LABEL = 'Výdajné miesto'
const MAIL_TOTAL_LABEL = 'Spolu'
const MAIL_AMOUNT_LABEL = 'Suma'

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

const admin = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
})

function withDb(fn) {
  if (!DB_PATH) return null
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
const guestRow = (id) => withDb((db) => db.prepare('SELECT * FROM guest_orders WHERE id = ?').get(Number(id)))
const linkRowCount = (linkId) =>
  withDb((db) => Number(db.prepare('SELECT COUNT(*) AS n FROM guest_orders WHERE link_id = ?').get(Number(linkId)).n))
const ledgerWatermark = () =>
  withDb((db) => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM transactions').get().n))

let phoneSeq = 0
const uniquePhone = () => `09${String(Date.now() % 1e7).padStart(7, '0')}${++phoneSeq % 10}`

let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gp1_${slug}`.slice(0, 30 - suffix.length) + suffix
  const name = `Peto ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: '0900 000 111' } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()
  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const body = await login.json()
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || body.token
  return { id: friend.id, name, token, auth: { Authorization: `Bearer ${token}` } }
}

// A coffee round at markup 1 (so the product price IS the guest price), optionally
// sending parcels at `fee`.
async function makeCycle(label, { parcel, fee } = {}) {
  const name = `E2E GP1 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  const patch = { markup_ratio: 1 }
  if (parcel !== undefined) patch.parcel_enabled = parcel
  if (fee !== undefined) patch.parcel_fee = fee
  expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: patch })).status(), 'cycle patch').toBe(200)
  return { ...cycle, name }
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

// One host + one parcel-capable round + one 24.90 product + the host's link.
async function scenario(label, { parcel = true, fee = 3.5 } = {}) {
  const host = await makeHost(label)
  const cycle = await makeCycle(label, { parcel, fee })
  const product = await addProduct(cycle.id, { name: `GP1 ${label} ${uniq}`, purpose: 'Espresso', price_250g: 24.9 })
  const link = await shareLink(host, cycle.id)
  const items = [{ product_id: product.id, variant: '250g', quantity: 1 }]
  return { host, cycle, product, link, items }
}

const identity = (extra = {}) => ({ guest_name: 'Zuzana Packetová', guest_phone: uniquePhone(), ...extra })
const packetaBody = (items, extra = {}) => ({
  ...identity({ guest_email: `gp1.${uniq}.${++phoneSeq}@example.test` }),
  items,
  use_parcel_delivery: true,
  packeta_address: '  Z-BOX Hlavná 15, Bratislava  ',
  ...extra,
})

async function submit(token, data) {
  return ctx.post(`/api/guest/${token}/orders`, { data })
}
async function submitOk(token, data) {
  const res = await submit(token, data)
  expect(res.status(), `submit: ${await res.text()}`).toBe(201)
  return res.json()
}

const setPaid = (id, paid) => admin(`/api/guest-orders/${id}/paid`, { method: 'patch', data: { paid } })

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})
test.afterAll(async () => { await ctx?.dispose() })

// ═════════════════════════════════════════════════════════════════════════════
// Throwaway-boot probe (the guest-standing-link / guest-waitlist idiom): a child
// `node` importing backend modules against a temp DB file. The suite's DB is never
// touched.
// ═════════════════════════════════════════════════════════════════════════════
function probe(dbFile, body, { pre } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gp-t1-probe-'))
  const script = join(dir, 'probe.mjs')
  if (pre) {
    // Build the OLD shape BEFORE schema.js ever opens the file.
    const db = new DatabaseSync(dbFile)
    db.exec(pre)
    db.close()
  }
  writeFileSync(
    script,
    `import db from '${srcUrl('db/schema.js')}';\n` +
      `import * as payment from '${srcUrl('helpers/payment.js')}';\n` +
      `const out = (() => {\n${body}\n})();\n` +
      `console.log('@@PROBE@@' + JSON.stringify(out));\n`
  )
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: { ...process.env, DB_PATH: dbFile },
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const m = stdout.match(/@@PROBE@@(.*)/)
    if (!m) throw new Error(`probe produced no marker. stdout:\n${stdout}`)
    return JSON.parse(m[1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gp-t1-db-'))
  try {
    return fn(join(dir, 'gp-t1.sqlite'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 UC-GP-001 — schema on an EXISTING database, and the one amount composer
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GP-T1 · 20 §UC-GP-001 — the three columns reach a database that predates them', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('a pre-module `guest_orders` (no delivery columns, one live row) gains all three on boot: 0 / NULL / NULL', () => {
    // The PROD shape as of GL-T7: guest_orders WITHOUT the three module-20 columns.
    const OLD = `
      CREATE TABLE guest_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id INTEGER NOT NULL,
        order_token TEXT UNIQUE NOT NULL,
        guest_name TEXT NOT NULL,
        guest_phone TEXT NOT NULL,
        guest_email TEXT,
        status TEXT DEFAULT 'submitted' CHECK (status IN ('submitted', 'cancelled')),
        total REAL DEFAULT 0,
        paid INTEGER DEFAULT 0,
        paid_at DATETIME,
        delivered INTEGER DEFAULT 0,
        delivered_at DATETIME,
        handed_over_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO guest_orders (link_id, order_token, guest_name, guest_phone, total, paid)
      VALUES (1, 'OLDTOKEN234567', 'Stará Objednávka', '0900111222', 12.5, 1);
    `
    const out = withTempDb((file) => probe(file, `
      const cols = db.all("PRAGMA table_info(guest_orders)").map((c) => ({ name: c.name, type: c.type, dflt: c.dflt_value }));
      const row = db.get("SELECT * FROM guest_orders WHERE order_token = 'OLDTOKEN234567'");
      return { cols, row };
    `, { pre: OLD }))
    const byName = Object.fromEntries(out.cols.map((c) => [c.name, c]))
    // Non-vacuity: the probe really started from the OLD shape (the row it inserted is there).
    expect(out.row, 'the pre-existing row survived the boot').toBeTruthy()
    expect(out.row.guest_name).toBe('Stará Objednávka')
    expect(byName.delivery_fee, 'delivery_fee ALTERed in').toMatchObject({ type: 'REAL', dflt: '0' })
    expect(byName.packeta_address, 'packeta_address ALTERed in').toMatchObject({ type: 'TEXT', dflt: null })
    expect(byName.delivery_fee_paid, 'delivery_fee_paid ALTERed in').toMatchObject({ type: 'REAL', dflt: null })
    expect(out.row.delivery_fee, 'an existing row is via_host: fee 0').toBe(0)
    expect(out.row.packeta_address, '…and no point').toBe(null)
    expect(out.row.delivery_fee_paid, 'NO back-fill of the paid snapshot, even on a paid row').toBe(null)
    expect(out.row.total, 'total untouched').toBe(12.5)
  })

  test('a FRESH database gets the same three columns from the CREATE (and a second boot is a no-op)', () => {
    const out = withTempDb((file) => {
      probe(file, 'return 1')
      return probe(file, `return db.all("PRAGMA table_info(guest_orders)").map((c) => c.name);`)
    })
    for (const col of ['delivery_fee', 'packeta_address', 'delivery_fee_paid']) {
      expect(out, col).toContain(col)
    }
  })

  test('guestPaymentBlock(): amount = roundMoney(total + delivery_fee); a via_host row is unchanged; reference untouched', () => {
    const out = withTempDb((file) => probe(file, `
      return {
        packeta: payment.guestPaymentBlock({ id: 5, total: 24.9, delivery_fee: 3.5, guest_name: 'Jana' }, 'Kolo'),
        viaHost: payment.guestPaymentBlock({ id: 5, total: 24.9, delivery_fee: 0, guest_name: 'Jana' }, 'Kolo'),
        legacy: payment.guestPaymentBlock({ id: 5, total: 12.5, guest_name: 'Jana' }, 'Kolo'),
        drift: payment.guestPaymentBlock({ id: 5, total: 0.1, delivery_fee: 0.2, guest_name: 'Jana' }, 'Kolo'),
        cancelled: payment.guestPaymentBlock({ id: 5, total: 0, delivery_fee: 0, guest_name: 'Jana' }, 'Kolo'),
      };
    `))
    expect(out.packeta.amount, 'the UC-GP-004 acceptance figure').toBe(28.4)
    expect(out.viaHost.amount).toBe(24.9)
    expect(out.legacy.amount, 'a row object without the column (never true in prod) still answers total').toBe(12.5)
    expect(out.drift.amount, '0.1 + 0.2 never reaches a QR as 0.30000000000000004').toBe(0.3)
    expect(out.cancelled.amount).toBe(0)
    expect(out.packeta.reference, 'R4.2: the reference is unchanged by a fee').toBe(out.viaHost.reference)
    expect(Object.keys(out.packeta), 'the six keys, in order — the block GROWS, never moves').toEqual([
      'amount', 'reference', 'variable_symbol', 'iban', 'revolut_username', 'creditor_name',
    ])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 UC-GP-001 — the published cycle flags
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GP-T1 · 20 §UC-GP-001 — cycle.parcel_enabled / parcel_fee on the guest payloads', () => {
  test('listing + status payload (both URL forms) carry the flags; a parcel-off round publishes 0 / 0', async () => {
    const on = await scenario('flagson', { parcel: true, fee: 3.5 })
    const off = await scenario('flagsoff', { parcel: false, fee: 0 })

    const listOn = await (await ctx.get(`/api/guest/${on.link.token}`)).json()
    expect(listOn.cycle.parcel_enabled).toBe(1)
    expect(listOn.cycle.parcel_fee).toBe(3.5)
    const listOff = await (await ctx.get(`/api/guest/${off.link.token}`)).json()
    expect(listOff.cycle.parcel_enabled).toBe(0)
    expect(listOff.cycle.parcel_fee).toBe(0)
    // Additive: the shipped keys are still first, in their shipped order.
    expect(Object.keys(listOff.cycle)).toEqual([
      'id', 'name', 'status', 'type', 'expected_date', 'plan_note', 'opens_at', 'closes_at', 'stage',
      'parcel_enabled', 'parcel_fee',
    ])

    const created = await submitOk(on.link.token, { ...identity(), items: on.items })
    const canonical = await (await ctx.get(`/api/guest/o/${created.order.order_token}`)).json()
    const legacy = await (await ctx.get(`/api/guest/${on.link.token}/orders/${created.order.order_token}`)).json()
    for (const [label, body] of [['canonical', canonical], ['legacy', legacy]]) {
      expect(body.cycle.parcel_enabled, label).toBe(1)
      expect(body.cycle.parcel_fee, label).toBe(3.5)
    }
    expect(JSON.stringify(canonical.cycle)).toBe(JSON.stringify(listOn.cycle))
  })

  test('the published fee is the ADMIN-rounded figure (3.456 ⇒ 3.46)', async () => {
    const s = await scenario('flagsround', { parcel: true, fee: 3.456 })
    const body = await (await ctx.get(`/api/guest/${s.link.token}`)).json()
    expect(body.cycle.parcel_fee).toBe(3.46)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §3 UC-GP-002 — the submit contract
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GP-T1 · 20 §UC-GP-002 — POST /api/guest/:token/orders', () => {
  test('a DEFAULT submit (no delivery keys) stores 0 / NULL; the 201 grows by exactly the two order columns', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('default')
    const created = await submitOk(s.link.token, { ...identity(), items: s.items })
    const row = guestRow(created.order.id)
    expect(row.delivery_fee).toBe(0)
    expect(row.packeta_address).toBe(null)
    expect(row.delivery_fee_paid).toBe(null)
    expect(row.total).toBe(24.9)
    expect(Object.keys(created), '201 top-level keys unchanged').toEqual(['order', 'items', 'payment', 'status_path'])
    expect(Object.keys(created.order), 'the shipped order keys, then the two new ones').toEqual([
      'id', 'link_id', 'order_token', 'guest_name', 'guest_phone', 'guest_email', 'status', 'total',
      'paid', 'paid_at', 'delivered', 'delivered_at', 'created_at', 'delivery_fee', 'packeta_address',
    ])
    expect(created.order.delivery_fee).toBe(0)
    expect(created.order.packeta_address).toBe(null)
    expect(created.payment.amount, 'via_host: the amount is the product total').toBe(24.9)
  })

  test('`false` / `null` are via_host too, and a stray `packeta_address` beside them is NOT stored', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('falsy')
    for (const flag of [false, null]) {
      const created = await submitOk(s.link.token, {
        ...identity(), items: s.items, use_parcel_delivery: flag, packeta_address: 'Z-BOX Nemá byť',
      })
      const row = guestRow(created.order.id)
      expect(row.packeta_address, `flag ${flag}`).toBe(null)
      expect(row.delivery_fee, `flag ${flag}`).toBe(0)
    }
  })

  test('a PACKETA submit: fee = roundMoney(parcel_fee), point trimmed, total product-only, amount = total + fee (row read back)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('packeta', { fee: 3.5 })
    const created = await submitOk(s.link.token, packetaBody(s.items, {
      // Hostile extras — server-set columns never come from the body.
      delivery_fee: 0.01, total: 1, delivery_fee_paid: 99, paid: 1,
    }))
    const row = guestRow(created.order.id)
    expect(row.delivery_fee, 'the CYCLE fee, never the body').toBe(3.5)
    expect(row.packeta_address, 'stored trimmed').toBe('Z-BOX Hlavná 15, Bratislava')
    expect(row.total, 'total stays PRODUCT-ONLY').toBe(24.9)
    expect(row.paid).toBe(0)
    expect(row.delivery_fee_paid, 'submit never writes the snapshot (paid toggle + cancel do)').toBe(null)
    expect(created.order.delivery_fee).toBe(3.5)
    expect(created.order.packeta_address).toBe('Z-BOX Hlavná 15, Bratislava')
    expect(created.order.total).toBe(24.9)
    expect(created.payment.amount, 'UC-GP-004: 24.90 + 3.50').toBe(28.4)

    // The status payload (both forms) quotes the same block.
    const canonical = await (await ctx.get(`/api/guest/o/${created.order.order_token}`)).json()
    const legacy = await (await ctx.get(`/api/guest/${s.link.token}/orders/${created.order.order_token}`)).json()
    expect(canonical.payment.amount).toBe(28.4)
    expect(JSON.stringify(canonical.payment)).toBe(JSON.stringify(created.payment))
    expect(JSON.stringify(legacy.payment)).toBe(JSON.stringify(created.payment))
    expect(canonical.order.delivery_fee).toBe(3.5)
    expect(canonical.order.packeta_address).toBe('Z-BOX Hlavná 15, Bratislava')
  })

  test('the fee is read from the cycle row AT SUBMIT: a fee raised after the page loaded is the one charged; 0 is legal and still Packeta', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('feechange', { fee: 3.5 })
    const listed = await (await ctx.get(`/api/guest/${s.link.token}`)).json()
    expect(listed.cycle.parcel_fee).toBe(3.5)
    expect((await admin(`/api/cycles/${s.cycle.id}`, { method: 'patch', data: { parcel_fee: 4 } })).status()).toBe(200)
    const raised = await submitOk(s.link.token, packetaBody(s.items))
    expect(guestRow(raised.order.id).delivery_fee, 'the fee at the moment of the write').toBe(4)
    expect(raised.payment.amount).toBe(28.9)

    expect((await admin(`/api/cycles/${s.cycle.id}`, { method: 'patch', data: { parcel_fee: 0 } })).status()).toBe(200)
    const free = await submitOk(s.link.token, packetaBody(s.items))
    const freeRow = guestRow(free.order.id)
    expect(freeRow.delivery_fee).toBe(0)
    expect(freeRow.packeta_address, 'the ADDRESS is the Packeta marker, not the fee').toBe('Z-BOX Hlavná 15, Bratislava')
  })

  test('a point of exactly 160 chars (after trim) is accepted; the host need not have ordered (Q4.c)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edge160')
    const point = 'Z'.repeat(160)
    const created = await submitOk(s.link.token, packetaBody(s.items, { packeta_address: `   ${point}\t` }))
    expect(guestRow(created.order.id).packeta_address).toBe(point)
  })

  test('a STANDING-token submit gets the identical Packeta contract (resolveEntry, 19 §UC-GL-002)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const host = await makeHost('standing')
    // Created LAST so it is the newest open round, i.e. the one `currentOpenCycle()` picks.
    const cycle = await makeCycle('standing', { parcel: true, fee: 2.9 })
    const product = await addProduct(cycle.id, { name: `GP1 standing ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const st = await ctx.get('/api/guest-links/standing', { headers: host.auth })
    expect(st.status()).toBe(200)
    const standingToken = (await st.json()).standing.token
    const listing = await (await ctx.get(`/api/guest/${standingToken}`)).json()
    expect(listing.cycle.id, 'the standing token resolves to THIS round').toBe(cycle.id)
    expect(listing.cycle.parcel_enabled).toBe(1)

    const items = [{ product_id: product.id, variant: '250g', quantity: 1 }]
    const bad = await submit(standingToken, packetaBody(items, { guest_email: undefined }))
    expect(bad.status()).toBe(400)
    expect(await bad.json()).toEqual({ error: ERR_EMAIL_MISSING, field: 'guest_email' })

    const created = await submitOk(standingToken, packetaBody(items))
    const row = guestRow(created.order.id)
    expect(row.delivery_fee).toBe(2.9)
    expect(row.packeta_address).toBe('Z-BOX Hlavná 15, Bratislava')
    expect(created.payment.amount).toBe(12.9)
  })

  // The 400 matrix. Every row: the exact message + `field`, and NO row written.
  const MATRIX = [
    // [label, cycle parcel?, body override, expected]
    ['parcel OFF', false, {}, { error: ERR_PARCEL_OFF, field: 'use_parcel_delivery' }],
    ['address missing', true, { packeta_address: undefined }, { error: ERR_ADDRESS_MISSING, field: 'packeta_address' }],
    ['address blank', true, { packeta_address: '   \t ' }, { error: ERR_ADDRESS_MISSING, field: 'packeta_address' }],
    ['address number', true, { packeta_address: 12345 }, { error: ERR_ADDRESS_MISSING, field: 'packeta_address' }],
    ['address object', true, { packeta_address: { toString: 1 } }, { error: ERR_ADDRESS_MISSING, field: 'packeta_address' }],
    ['address array', true, { packeta_address: ['Z-BOX'] }, { error: ERR_ADDRESS_MISSING, field: 'packeta_address' }],
    ['address 161', true, { packeta_address: 'Z'.repeat(161) }, { error: ERR_ADDRESS_LONG, field: 'packeta_address' }],
    ['e-mail missing', true, { guest_email: undefined }, { error: ERR_EMAIL_MISSING, field: 'guest_email' }],
    ['e-mail blank', true, { guest_email: '   ' }, { error: ERR_EMAIL_MISSING, field: 'guest_email' }],
    ['e-mail null', true, { guest_email: null }, { error: ERR_EMAIL_MISSING, field: 'guest_email' }],
    ['e-mail x', true, { guest_email: 'x' }, { error: ERR_EMAIL_SHAPE, field: 'guest_email' }],
    ['e-mail no dot', true, { guest_email: 'jana@localhost' }, { error: ERR_EMAIL_SHAPE, field: 'guest_email' }],
    ['flag "true"', true, { use_parcel_delivery: 'true' }, { error: ERR_METHOD, field: 'use_parcel_delivery' }],
    ['flag 1', true, { use_parcel_delivery: 1 }, { error: ERR_METHOD, field: 'use_parcel_delivery' }],
    ['flag [true]', true, { use_parcel_delivery: [true] }, { error: ERR_METHOD, field: 'use_parcel_delivery' }],
    ['flag {}', true, { use_parcel_delivery: {} }, { error: ERR_METHOD, field: 'use_parcel_delivery' }],
    ['flag "false"', true, { use_parcel_delivery: 'false' }, { error: ERR_METHOD, field: 'use_parcel_delivery' }],
    ['flag 0', true, { use_parcel_delivery: 0 }, { error: ERR_METHOD, field: 'use_parcel_delivery' }],
  ]

  test('the 400 matrix: each refusal names its field, says the exact message, and writes NO row', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const on = await scenario('matrixon')
    const off = await scenario('matrixoff', { parcel: false })
    for (const [label, parcel, override, expected] of MATRIX) {
      const s = parcel ? on : off
      const body = packetaBody(s.items)
      for (const [k, v] of Object.entries(override)) {
        if (v === undefined) delete body[k]
        else body[k] = v
      }
      const before = linkRowCount(s.link.id)
      const res = await submit(s.link.token, body)
      expect(res.status(), label).toBe(400)
      expect(await res.json(), label).toEqual(expected)
      expect(linkRowCount(s.link.id), `${label}: COUNT(*) unmoved`).toBe(before)
    }
    // Non-vacuity: the same fixture DOES accept the valid body (the 400s are the
    // matrix talking, not a broken link), and the count then moves by exactly one.
    const before = linkRowCount(on.link.id)
    await submitOk(on.link.token, packetaBody(on.items))
    expect(linkRowCount(on.link.id)).toBe(before + 1)
  })

  test('gate ORDER: identity → delivery → pricing/empty cart → stock', async () => {
    const s = await scenario('order')
    // identity beats a bad flag
    let res = await submit(s.link.token, { ...packetaBody(s.items), guest_name: '', use_parcel_delivery: 'x' })
    expect(await res.json()).toMatchObject({ field: 'guest_name' })
    // a bad flag beats an empty cart (delivery before pricing)
    res = await submit(s.link.token, { ...packetaBody([]), use_parcel_delivery: 1 })
    expect(res.status()).toBe(400)
    expect(await res.json()).toEqual({ error: ERR_METHOD, field: 'use_parcel_delivery' })
    // a bad point beats an empty cart
    res = await submit(s.link.token, { ...packetaBody([]), packeta_address: '' })
    expect(await res.json()).toEqual({ error: ERR_ADDRESS_MISSING, field: 'packeta_address' })
    // a VALID delivery block reaches the empty-cart 400
    res = await submit(s.link.token, packetaBody([]))
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('Košík je prázdny')
    // parcel availability is checked BEFORE the point: parcel-off + no point ⇒ the parcel message
    const off = await scenario('orderoff', { parcel: false })
    res = await submit(off.link.token, { ...packetaBody(off.items), packeta_address: undefined, guest_email: undefined })
    expect(await res.json()).toEqual({ error: ERR_PARCEL_OFF, field: 'use_parcel_delivery' })
  })

  test('unbindable WHOLE bodies ({} / true / [1] / "abc") answer 400, never 500', async () => {
    const s = await scenario('shapes')
    for (const [label, raw] of [['{}', '{}'], ['true', 'true'], ['[1]', '[1]'], ['[true]', '[true]'], ['"abc"', '"abc"'], ['abc', 'abc']]) {
      const res = await ctx.post(`/api/guest/${s.link.token}/orders`, {
        headers: { 'Content-Type': 'application/json' },
        data: raw,
      })
      expect(res.status(), label).toBe(400)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §4 UC-GP-001 — the shared list: every host/admin surface carries the columns
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GP-T1 · 20 §UC-GP-001 — GUEST_ORDER_FIELDS publishes delivery_fee + packeta_address', () => {
  test('host view, admin orders tab and /distribution carry both; host `totals.total` stays PRODUCT-ONLY', async () => {
    const s = await scenario('surfaces', { fee: 3.5 })
    const packeta = await submitOk(s.link.token, packetaBody(s.items))
    const viaHost = await submitOk(s.link.token, { ...identity(), items: s.items })

    const host = await (await ctx.get(`/api/guest-links/cycle/${s.cycle.id}`, { headers: s.host.auth })).json()
    const hp = host.guest_orders.find((o) => o.id === packeta.order.id)
    const hv = host.guest_orders.find((o) => o.id === viaHost.order.id)
    expect(hp).toMatchObject({ delivery_fee: 3.5, packeta_address: 'Z-BOX Hlavná 15, Bratislava', total: 24.9 })
    expect(hv).toMatchObject({ delivery_fee: 0, packeta_address: null })
    expect(Object.keys(hp), 'the snapshot column is not on the shared list').not.toContain('delivery_fee_paid')
    expect(host.totals, 'GSO-T5 pin: count + PRODUCT total, no fee').toEqual({ count: 2, total: 49.8 })

    const ordersRes = await admin(`/api/orders/cycle/${s.cycle.id}`)
    expect(ordersRes.status()).toBe(200)
    const orders = await ordersRes.json()
    const nested = orders.flatMap((o) => o.guest_orders || []).find((o) => o.id === packeta.order.id)
    expect(nested, 'the admin orders tab nests the sub-order').toBeTruthy()
    expect(nested).toMatchObject({ delivery_fee: 3.5, packeta_address: 'Z-BOX Hlavná 15, Bratislava' })

    const distRes = await admin(`/api/cycles/${s.cycle.id}/distribution`)
    expect(distRes.status()).toBe(200)
    const dist = await distRes.json()
    const parties = Array.isArray(dist) ? dist : (dist.distribution || dist.parties || [])
    const inDist = parties.flatMap((p) => p.guest_orders || []).find((o) => o.id === viaHost.order.id)
    expect(inDist, '/distribution lists the via_host sub-order under its host').toBeTruthy()
    expect(inDist).toMatchObject({ delivery_fee: 0, packeta_address: null })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §5 UC-GP-006 — cancel zeroes the fee (three doors) + the paid snapshot
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GP-T1 · 20 §UC-GP-006 — softCancelGuestOrder zeroes delivery_fee on all three doors', () => {
  test('guest `items: []` + admin cancel on a PAID Packeta row, host DELETE on an unpaid one: fee 0, point KEPT, snapshot frozen', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('cancel', { fee: 3.5 })

    // Door 1 — the guest's own empty-cart PUT, on a PAID row (cancel stays open, D2).
    const g = await submitOk(s.link.token, packetaBody(s.items))
    expect((await setPaid(g.order.id, true)).status()).toBe(200)
    expect((await ctx.put(`/api/guest/o/${g.order.order_token}`, { data: { items: [] } })).status()).toBe(200)

    // Door 3 — the admin cancel, on a PAID row (no paid blockade, 14 D4).
    const a = await submitOk(s.link.token, packetaBody(s.items))
    expect((await setPaid(a.order.id, true)).status()).toBe(200)
    expect((await admin(`/api/guest-orders/${a.order.id}/cancel`, { method: 'post' })).status()).toBe(200)

    for (const [label, id] of [['guest door', g.order.id], ['admin door', a.order.id]]) {
      const row = guestRow(id)
      expect(row, label).toMatchObject({
        status: 'cancelled', total: 0, delivery_fee: 0,
        packeta_address: 'Z-BOX Hlavná 15, Bratislava', paid: 1, delivery_fee_paid: 3.5,
      })
      expect(row.guest_email, `${label}: e-mail untouched`).toMatch(/@example\.test$/)
    }

    // Door 2 — the host DELETE. It keeps its own 409 `paid` gate (unchanged), so the
    // paid row is refused and read back untouched…
    const h = await submitOk(s.link.token, packetaBody(s.items))
    expect((await setPaid(h.order.id, true)).status()).toBe(200)
    const refused = await ctx.delete(`/api/guest-orders/${h.order.id}`, { headers: s.host.auth })
    expect(refused.status()).toBe(409)
    expect(guestRow(h.order.id)).toMatchObject({ status: 'submitted', delivery_fee: 3.5, total: 24.9 })
    // …and on an unpaid row it zeroes the fee through the same statement.
    expect((await setPaid(h.order.id, false)).status()).toBe(200)
    expect((await ctx.delete(`/api/guest-orders/${h.order.id}`, { headers: s.host.auth })).status()).toBe(200)
    expect(guestRow(h.order.id)).toMatchObject({
      status: 'cancelled', total: 0, delivery_fee: 0, packeta_address: 'Z-BOX Hlavná 15, Bratislava',
      paid: 0, delivery_fee_paid: 3.5, // cancel freezes the fee (orchestrator decision 2026-09-23)
    })

    // The cancelled status payload asks for nothing.
    const status = await (await ctx.get(`/api/guest/o/${g.order.order_token}`)).json()
    expect(status.payment.amount).toBe(0)
    expect(status.order.packeta_address, 'the record survives on the guest page too').toBe('Z-BOX Hlavná 15, Bratislava')
  })
})

// ⚠ ~~written ONLY by the admin paid toggle~~ — SUPERSEDED by the orchestrator decision
// of 2026-09-23 (GP-T1 review, pending PO; learnings 12 §6): the snapshot is „the fee part
// of what the guest was asked to pay, frozen at the FIRST of {paid, cancel}", with TWO
// writers — `softCancelGuestOrder` (COALESCE) and the paid toggle (paid=1 COALESCE; paid=0
// NULL on a live row, KEPT on a cancelled one). `refundAmount()` below is GP-T5's pinned
// semantics, `itemsAmount + (paid ? delivery_fee_paid || 0 : 0)`, computed off the row.
function refundAmount(id) {
  const row = guestRow(id)
  const items = withDb((db) =>
    db.prepare('SELECT price, quantity FROM guest_order_items WHERE guest_order_id = ?').all(Number(id)))
  const itemsAmount = items.reduce((sum, it) => sum + it.price * it.quantity, 0)
  return Math.round((itemsAmount + (row.paid ? row.delivery_fee_paid || 0 : 0)) * 100) / 100
}
// Test-side fixture write: the live fee of a sub-order can only change through GP-T2's edit
// / GP-T5's delivery PATCH, neither of which exists yet — so the „edit fee" step of the
// last sequence sets the column directly, exactly as those writers will.
function setLiveFee(id, fee) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.prepare('UPDATE guest_orders SET delivery_fee = ? WHERE id = ?').run(fee, Number(id))
  } finally {
    db.close()
  }
}

test.describe('GP-T1 · the `delivery_fee_paid` snapshot — frozen at the FIRST of {paid, cancel}, TWO writers', () => {
  const snap = (id) => {
    const r = guestRow(id)
    return { paid: r.paid, status: r.status, delivery_fee: r.delivery_fee, delivery_fee_paid: r.delivery_fee_paid }
  }

  test('submit writes no snapshot; body values are ignored; a via_host row snapshots 0', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('snapnone', { fee: 3.5 })
    const p = await submitOk(s.link.token, packetaBody(s.items, { delivery_fee_paid: 99 }))
    expect(guestRow(p.order.id).delivery_fee_paid).toBe(null)
    const v = await submitOk(s.link.token, { ...identity(), items: s.items })
    expect((await setPaid(v.order.id, true)).status()).toBe(200)
    expect(guestRow(v.order.id).delivery_fee_paid).toBe(0)
  })

  test('pay → cancel ⇒ refund 28.40 (items + the fee that was paid)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('snappc', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    expect(snap(o.order.id)).toEqual({ paid: 1, status: 'submitted', delivery_fee: 3.5, delivery_fee_paid: 3.5 })
    expect((await admin(`/api/guest-orders/${o.order.id}/cancel`, { method: 'post' })).status()).toBe(200)
    expect(snap(o.order.id)).toEqual({ paid: 1, status: 'cancelled', delivery_fee: 0, delivery_fee_paid: 3.5 })
    expect(refundAmount(o.order.id)).toBe(28.4)
  })

  test('⚠ the review scenario — cancel → pay ⇒ refund 28.40, not 24.90 (cancel freezes the fee)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('snapcp', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    // the guest paid 28.40, then cancelled BEFORE the admin matched the transfer
    expect((await ctx.put(`/api/guest/o/${o.order.order_token}`, { data: { items: [] } })).status()).toBe(200)
    expect(snap(o.order.id), 'cancel froze the fee it zeroed')
      .toEqual({ paid: 0, status: 'cancelled', delivery_fee: 0, delivery_fee_paid: 3.5 })
    expect(refundAmount(o.order.id), 'unpaid ⇒ items only (no fee was paid yet)').toBe(24.9)
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    expect(snap(o.order.id)).toEqual({ paid: 1, status: 'cancelled', delivery_fee: 0, delivery_fee_paid: 3.5 })
    expect(refundAmount(o.order.id)).toBe(28.4)
  })

  test('pay → unpay → pay on a LIVE row: 3.5 → NULL → 3.5', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('snappup', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    expect(snap(o.order.id).delivery_fee_paid).toBe(3.5)
    expect((await setPaid(o.order.id, false)).status()).toBe(200)
    expect(snap(o.order.id)).toEqual({ paid: 0, status: 'submitted', delivery_fee: 3.5, delivery_fee_paid: null })
    // the absent-field TOGGLE takes the same statements
    expect((await admin(`/api/guest-orders/${o.order.id}/paid`, { method: 'patch', data: {} })).status()).toBe(200)
    expect(snap(o.order.id)).toEqual({ paid: 1, status: 'submitted', delivery_fee: 3.5, delivery_fee_paid: 3.5 })
  })

  test('cancel → pay → unpay → pay: the snapshot survives the untick on a CANCELLED row and the re-tick restores the refund', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('snapcpup', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    expect((await admin(`/api/guest-orders/${o.order.id}/cancel`, { method: 'post' })).status()).toBe(200)
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    expect(snap(o.order.id).delivery_fee_paid).toBe(3.5)
    expect((await setPaid(o.order.id, false)).status()).toBe(200)
    expect(snap(o.order.id), 'cancelled ⇒ the historical fee is KEPT')
      .toEqual({ paid: 0, status: 'cancelled', delivery_fee: 0, delivery_fee_paid: 3.5 })
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    expect(snap(o.order.id)).toEqual({ paid: 1, status: 'cancelled', delivery_fee: 0, delivery_fee_paid: 3.5 })
    expect(refundAmount(o.order.id)).toBe(28.4)
  })

  test('live pay → unpay → the fee changes → pay: the NEW fee is copied', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('snapfee', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    expect((await setPaid(o.order.id, false)).status()).toBe(200)
    setLiveFee(o.order.id, 4)
    expect(snap(o.order.id)).toEqual({ paid: 0, status: 'submitted', delivery_fee: 4, delivery_fee_paid: null })
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    expect(snap(o.order.id).delivery_fee_paid).toBe(4)
    // …and an existing snapshot then wins over a later live change (COALESCE, not a copy)
    setLiveFee(o.order.id, 5)
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    expect(snap(o.order.id).delivery_fee_paid).toBe(4)
  })

  test('pay → the live fee changes → cancel: the cancel does NOT overwrite the snapshot the tick froze (COALESCE, first wins)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('snapfirst', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    setLiveFee(o.order.id, 4)
    expect((await admin(`/api/guest-orders/${o.order.id}/cancel`, { method: 'post' })).status()).toBe(200)
    expect(snap(o.order.id)).toEqual({ paid: 1, status: 'cancelled', delivery_fee: 0, delivery_fee_paid: 3.5 })
    expect(refundAmount(o.order.id)).toBe(28.4)
  })

  test('source pin: `delivery_fee_paid` is WRITTEN in exactly TWO places — the soft cancel and the paid route (all of backend/src)', () => {
    test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)
    // Walk backend/src RECURSIVELY — a typed file list is how a writer in an unlisted file
    // stays invisible (the PI-T11 importClosure lesson).
    const files = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(m?js|cjs)$/.test(entry.name)) files.push(relative(BACKEND_SRC, full))
      }
    }
    walk(BACKEND_SRC)
    // Readability gate: the walk saw the tree, and the strip did not eat the two files
    // the positive assertions below depend on (a `//` inside a string can open a hole).
    expect(files.length, 'the walk saw backend/src').toBeGreaterThan(30)
    for (const f of ['db/schema.js', 'routes/guest.js', 'routes/guest-orders.js', 'helpers/guest-orders.js']) {
      expect(files, f).toContain(f)
    }
    const code = Object.fromEntries(files.map((f) => [f, stripComments(readBackend(f))]))
    expect(code['routes/guest-orders.js'], 'strip kept the paid route').toContain("router.patch('/:id/paid'")
    expect(code['routes/guest-orders.js'], 'strip kept the file tail').toContain('export default router')
    expect(code['helpers/guest-orders.js'], 'strip kept the soft cancel').toContain('export function softCancelGuestOrder')
    expect(code['helpers/guest-orders.js'], 'strip kept the file tail').toContain('export function findSubOrderWithLink')

    const writers = files.filter((f) => /delivery_fee_paid\s*=/.test(code[f])).sort()
    expect(writers).toEqual(['helpers/guest-orders.js', 'routes/guest-orders.js'])
    const helper = code['helpers/guest-orders.js']
    expect(helper.match(/delivery_fee_paid\s*=/g)).toHaveLength(1)
    expect(helper).toMatch(
      /SET status = 'cancelled', total = 0, delivery_fee = 0,\s*delivery_fee_paid = COALESCE\(delivery_fee_paid, delivery_fee\)/)
    const route = code['routes/guest-orders.js']
    expect(route.match(/delivery_fee_paid\s*=/g), 'paid=1 and paid=0, nothing else').toHaveLength(2)
    expect(route).toContain('delivery_fee_paid = COALESCE(delivery_fee_paid, delivery_fee)')
    expect(route).toContain("delivery_fee_paid = CASE WHEN status = 'cancelled' THEN delivery_fee_paid ELSE NULL END")

    // Negative pin: no INSERT ever seeds the snapshot (a submit writes none — only the
    // first of {paid, cancel} may). Non-vacuity: the submit's INSERT IS found.
    const inserts = files.flatMap((f) =>
      [...code[f].matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+guest_orders\s*\(([^)]*)\)/gi)].map((m) => ({ f, cols: m[1] })))
    expect(inserts.some((x) => x.f === 'routes/guest.js' && /packeta_address/.test(x.cols)), 'the submit INSERT was read').toBe(true)
    for (const { f, cols } of inserts) {
      expect(cols, `${f}: an INSERT INTO guest_orders column list`).not.toMatch(/delivery_fee_paid/)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §6 Ledger — guests have NO balance
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GP-T1 · no `transactions` row, ever', () => {
  test('MAX(transactions.id) is unmoved across a Packeta submit, the paid toggle both ways and each cancel door', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('ledger', { fee: 3.5 })
    const mark = ledgerWatermark()
    const check = (label) => expect(ledgerWatermark(), label).toBe(mark)

    const a = await submitOk(s.link.token, packetaBody(s.items)); check('submit')
    await setPaid(a.order.id, true); check('paid on')
    await setPaid(a.order.id, false); check('paid off')
    await ctx.put(`/api/guest/o/${a.order.order_token}`, { data: { items: [] } }); check('guest cancel')
    const b = await submitOk(s.link.token, packetaBody(s.items))
    await ctx.delete(`/api/guest-orders/${b.order.id}`, { headers: s.host.auth }); check('host cancel')
    const c = await submitOk(s.link.token, packetaBody(s.items))
    await setPaid(c.order.id, true)
    await admin(`/api/guest-orders/${c.order.id}/cancel`, { method: 'post' }); check('admin cancel')
    // Non-vacuity: all three really cancelled.
    for (const id of [a.order.id, b.order.id, c.order.id]) expect(guestRow(id).status).toBe('cancelled')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §7 UC-GP-004 — the confirmation mail (the shared Mailgun stub harness, self-skipping)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GP-T1 · 20 §UC-GP-004 — the confirmation mail carries the fee and the point', () => {
  test('a Packeta submit ⇒ ONE send whose text has the fee row, the fee-inclusive Spolu/Suma and the point, in order', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_BACKEND_SRC)
    const saved = { ctx, adminToken }
    try {
      await withMailHarness({ MAILGUN_API_KEY: FAKE_MAILGUN_KEY, MAILGUN_DOMAIN: STUB_MAILGUN_DOMAIN }, async (h) => {
        ctx = h.ctx
        adminToken = h.adminToken
        const s = await scenario('mail', { fee: 3.5 })
        const created = await submitOk(s.link.token, packetaBody(s.items))
        await expect.poll(() => h.stub.requests.length, { timeout: 10_000 }).toBe(1)
        const { text, html } = multipartFields(h.stub.requests[0])
        // FormData normalises the text field's newlines to CRLF on the wire.
        const lines = text.split(/\r?\n/)
        const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix))
        const item = lines.findIndex((l) => l.startsWith('1× '))
        const fee = at(`${MAIL_DELIVERY_LABEL}: `)
        const total = at(`${MAIL_TOTAL_LABEL}: `)
        const point = at(`${MAIL_PACKETA_LABEL}: `)
        expect(lines[fee]).toBe(`${MAIL_DELIVERY_LABEL}: 3.50 €`)
        expect(lines[total]).toBe(`${MAIL_TOTAL_LABEL}: 28.40 EUR`)
        expect(lines[point]).toBe(`${MAIL_PACKETA_LABEL}: Z-BOX Hlavná 15, Bratislava`)
        expect(lines[at(`${MAIL_AMOUNT_LABEL}: `)]).toBe(`${MAIL_AMOUNT_LABEL}: 28.40 EUR`)
        expect(item, 'the item line is there').toBeGreaterThan(-1)
        expect(item < fee && fee < total && total < point, 'item → fee → Spolu → point').toBe(true)
        expect(lines[item], 'the fee is NOT an item line').not.toContain('Packet')
        expect(text).toContain(`/g/o/${created.order.order_token}`)
        expect(html).toContain('Z-BOX Hlavná 15, Bratislava')
        expect(html).toContain('28.40')
        expect(html).toContain(MAIL_DELIVERY_LABEL)
      })
    } finally {
      ctx = saved.ctx
      adminToken = saved.adminToken
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §8 Source pins
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GP-T1 · source pins', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('EMAIL_SHAPE: ONE regex, exported by the mailer and imported by routes/guest.js (no second copy)', () => {
    const mailer = stripComments(readBackend('helpers/mailer.js'))
    const guest = stripComments(readBackend('routes/guest.js'))
    expect(mailer).toMatch(/export const EMAIL_SHAPE = \//)
    expect(guest).toMatch(/import \{[^}]*\bEMAIL_SHAPE\b[^}]*\} from '\.\.\/helpers\/mailer\.js'/)
    expect(guest).toContain('EMAIL_SHAPE.test(')
    expect(guest, 'no hand-rolled e-mail regex in the public route').not.toMatch(/\/\^\[\^\\s@/)
  })

  test('the submit keeps its bucket: guestWriteLimiter on the route, still FIVE limiters exported', () => {
    const guest = stripComments(readBackend('routes/guest.js'))
    expect(guest).toMatch(/router\.post\('\/:token\/orders', guestWriteLimiter,/)
    const rl = stripComments(readBackend('middleware/rate-limit.js'))
    expect(rl.match(/^export const \w+Limiter/gm)).toHaveLength(5)
  })

  test('`total` stays product-only on the submit write, the fee is re-read INSIDE the transaction, and the soft cancel names four literal columns', () => {
    const guest = stripComments(readBackend('routes/guest.js'))
    expect(guest, 'the fee is read with the status, inside db.transaction').toMatch(
      /db\.transaction\(\(\) => \{[\s\S]*?SELECT status, parcel_fee FROM order_cycles[\s\S]*?INSERT INTO guest_orders/
    )
    // …and THAT const is what is bound: the INSERT's `.run(...)` names `deliveryFee`.
    expect(guest).toMatch(
      /\.run\(link\.id, uniqueOrderToken\(\), guestName, guestPhone, guestEmail, deliveryFee, delivery\.address\)/)
    // …and the CHARGED fee is that in-tx read (`current`), never the resolver's `cycle`
    // row — over HTTP the two always agree (sync handlers), so only this pin can see it.
    expect(guest).toMatch(/const deliveryFee = delivery\.packeta \? roundMoney\(Number\(current\.parcel_fee\) \|\| 0\) : 0;/)
    expect(guest, 'the resolver row never prices the fee').not.toMatch(/roundMoney\(Number\(cycle\.parcel_fee\)[^\n]*: 0;/)
    expect(guest, 'no write folds the fee into total').not.toMatch(/total\s*=\s*[^;\n]*delivery_fee/)
    const helper = stripComments(readBackend('helpers/guest-orders.js'))
    expect(helper).toMatch(/UPDATE guest_orders\s+SET status = 'cancelled', total = 0, delivery_fee = 0,/)
    expect(helper, 'the address is the record — never cleared by cancel').not.toMatch(/packeta_address\s*=\s*NULL/)
  })

  test('the new guest-facing server strings never say „cyklus"/„kolo" (e2e/helpers/vocabulary.js BANNED)', () => {
    for (const s of [ERR_METHOD, ERR_PARCEL_OFF, ERR_ADDRESS_MISSING, ERR_ADDRESS_LONG, ERR_EMAIL_MISSING,
      MAIL_DELIVERY_LABEL, MAIL_PACKETA_LABEL]) {
      expect(s).not.toMatch(BANNED)
      expect(readBackend('routes/guest.js'), `the route really carries „${s}"`).toContain(s.replace(' (najviac 160 znakov)', ''))
    }
  })
})
