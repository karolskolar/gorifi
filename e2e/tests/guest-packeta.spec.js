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
import { stripComments, assertReadable, code as frontCode, HAS_SRC, NEEDS_SRC } from '../helpers/source-pins.js'
// GP-T3 (20 §UC-GP-011 item 1) — the pixel-QR pair, shared with guest-payment-modal.spec.js.
import { readQrModules, independentQr } from '../helpers/qr-pixels.js'
import { decode as decodeBySquare } from '../../frontend/node_modules/bysquare/lib/index.js'
// GP-T3 (20 §UC-GP-003 item 4) — the client mirror of the mailer's regex.
import { EMAIL_SHAPE as CLIENT_EMAIL_SHAPE } from '../../frontend/src/lib/email-shape.js'
import { BANNED } from '../helpers/vocabulary.js'
import { collectAppCopy } from '../helpers/copy-sweep.js'
// GP-T4 (20 §UC-GP-008) — the ONE home of portal → order-screen navigation.
import { gotoCycle as portalGotoCycle } from '../helpers/portal.js'
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
// Test-side fixture write. ⚠ RE-POINTED by GP-T2 (learnings 12 §6/§9): wherever the
// sequence changes the fee of an UNPAID row it now goes through the real writer — the
// edit PUT carrying `use_parcel_delivery: true` after the admin moved `parcel_fee`
// (`repriceByEdit()`). What is LEFT here are the steps that change the fee of a PAID
// row: the edit cannot reach that state (D2 — a paid row's method is frozen with its
// items, 409 `paid`, pinned right beside each call), so only GP-T5's delivery PATCH
// (which zeroes it) will be a real writer there — re-point those at it when it lands.
async function repriceByEdit(s, o, fee) {
  expect((await admin(`/api/cycles/${s.cycle.id}`, { method: 'patch', data: { parcel_fee: fee } })).status()).toBe(200)
  const res = await ctx.put(`/api/guest/o/${o.order.order_token}`, {
    data: { items: s.items, use_parcel_delivery: true, packeta_address: 'Z-BOX Hlavná 15, Bratislava' },
  })
  expect(res.status(), `the edit re-reads the fee: ${await res.text()}`).toBe(200)
}
async function paidEditRefused(s, o) {
  const res = await ctx.put(`/api/guest/o/${o.order.order_token}`, {
    data: { items: s.items, use_parcel_delivery: true, packeta_address: 'Z-BOX Hlavná 15, Bratislava' },
  })
  expect(res.status(), 'a PAID row cannot be repriced by the edit (D2)').toBe(409)
}
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
    await repriceByEdit(s, o, 4) // GP-T2: the real writer
    expect(snap(o.order.id)).toEqual({ paid: 0, status: 'submitted', delivery_fee: 4, delivery_fee_paid: null })
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    expect(snap(o.order.id).delivery_fee_paid).toBe(4)
    // …and an existing snapshot then wins over a later live change (COALESCE, not a copy).
    // The row is PAID here, so the edit cannot move the fee (fixture stand-in for GP-T5).
    await paidEditRefused(s, o)
    expect(snap(o.order.id).delivery_fee, 'the refused edit wrote nothing').toBe(4)
    setLiveFee(o.order.id, 5)
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    expect(snap(o.order.id).delivery_fee_paid).toBe(4)
  })

  test('pay → the live fee changes → cancel: the cancel does NOT overwrite the snapshot the tick froze (COALESCE, first wins)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('snapfirst', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    expect((await setPaid(o.order.id, true)).status()).toBe(200)
    await paidEditRefused(s, o) // PAID ⇒ the edit is no writer here (fixture stand-in for GP-T5)
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
  test('MAX(transactions.id) is unmoved across a Packeta submit, the edit both ways (GP-T2), the paid toggle both ways and each cancel door', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('ledger', { fee: 3.5 })
    const mark = ledgerWatermark()
    const check = (label) => expect(ledgerWatermark(), label).toBe(mark)

    const a = await submitOk(s.link.token, packetaBody(s.items)); check('submit')
    // GP-T2 — the edit PUT switching both ways (the fee is re-read and written; no ledger)
    const put = (data) => ctx.put(`/api/guest/o/${a.order.order_token}`, { data })
    expect((await put({ items: s.items, use_parcel_delivery: false })).status()).toBe(200); check('edit → via_host')
    expect(guestRow(a.order.id).delivery_fee, 'non-vacuity: the switch wrote').toBe(0)
    expect((await put({ items: s.items, use_parcel_delivery: true, packeta_address: 'Bod 1' })).status()).toBe(200); check('edit → Packeta')
    expect(guestRow(a.order.id).delivery_fee, 'non-vacuity: the switch wrote').toBe(3.5)
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
// §7b UC-GP-005 — the edit PUT's delivery block (GP-T2), BOTH URL forms
// ═════════════════════════════════════════════════════════════════════════════
// The shared `handleStatusEdit` is reached by the canonical `/o/:orderToken` and the
// legacy `/:token/orders/:orderToken` pair — every rule below is exercised on both, and
// every refusal reads the row back (the response is not evidence of what was stored).
const ERR_EMAIL_LONG = 'E-mail je príliš dlhý (najviac 160 znakov)'
const editCanonical = (o) => (data) => ctx.put(`/api/guest/o/${o.order.order_token}`, { data })
const editLegacy = (link, o) => (data) => ctx.put(`/api/guest/${link.token}/orders/${o.order.order_token}`, { data })
const setCycle = (id, patch) => admin(`/api/cycles/${id}`, { method: 'patch', data: patch })
// The columns the edit may touch, plus the identity it may NOT (bar the write-once e-mail).
const editRow = (id) => {
  const r = guestRow(id)
  const items = withDb((db) => db.prepare(
    'SELECT product_id, variant, quantity, price FROM guest_order_items WHERE guest_order_id = ? ORDER BY id').all(Number(id)))
  return {
    status: r.status, total: r.total, delivery_fee: r.delivery_fee, packeta_address: r.packeta_address,
    guest_name: r.guest_name, guest_phone: r.guest_phone, guest_email: r.guest_email,
    paid: r.paid, delivery_fee_paid: r.delivery_fee_paid, items: items.map((i) => ({ ...i })),
  }
}
const viaHostBody = (items, extra = {}) => ({ ...identity(), items, ...extra })
const twoBags = (s) => [{ ...s.items[0], quantity: 2 }]
const POINT = 'Z-BOX Hlavná 15, Bratislava'

test.describe('GP-T2 · 20 §UC-GP-005 — the edit PUT switches pickup ↔ Packeta', () => {
  test('via_host → Packeta on an e-mail-less order stores the e-mail ONCE; a second PUT with a different e-mail ⇒ 200, unchanged (both URL forms)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edit2p', { fee: 3.5 })
    const o = await submitOk(s.link.token, viaHostBody(s.items))
    expect(editRow(o.order.id)).toMatchObject({ delivery_fee: 0, packeta_address: null, guest_email: null })
    const first = `gp2.first.${uniq}@example.test`

    // canonical form — the switch, with the body e-mail
    const res = await editCanonical(o)({
      items: twoBags(s), use_parcel_delivery: true, packeta_address: `  ${POINT}  `, guest_email: `  ${first}  `,
      guest_name: 'Prepísané Meno', guest_phone: '0911 999 999', // identity freeze — ignored
    })
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    const row = editRow(o.order.id)
    expect(row).toMatchObject({
      status: 'submitted', total: 49.8, delivery_fee: 3.5, packeta_address: POINT, guest_email: first,
      guest_name: 'Zuzana Packetová', guest_phone: o.order.guest_phone, delivery_fee_paid: null,
    })
    expect(body.order).toMatchObject({ delivery_fee: 3.5, packeta_address: POINT, total: 49.8 })
    expect(body.payment.amount, 'amount = total + fee').toBe(53.3)

    // legacy pair form — a DIFFERENT body e-mail on a row that now has one ⇒ ignored, 200
    const again = await editLegacy(s.link, o)({
      items: s.items, use_parcel_delivery: true, packeta_address: POINT, guest_email: `gp2.second.${uniq}@example.test`,
    })
    expect(again.status(), await again.text()).toBe(200)
    expect(editRow(o.order.id)).toMatchObject({ guest_email: first, total: 24.9, delivery_fee: 3.5 })
    // …and a GARBAGE body e-mail beside a stored one is ignored too — never validated, never an error
    const garbage = await editCanonical(o)({ items: s.items, use_parcel_delivery: true, packeta_address: POINT, guest_email: { x: 1 } })
    expect(garbage.status(), await garbage.text()).toBe(200)
    expect(editRow(o.order.id).guest_email).toBe(first)
  })

  test('a Packeta row with an e-mail from checkout needs no body e-mail; a via_host PUT never writes a body e-mail', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edit2mail', { fee: 3.5 })
    const p = await submitOk(s.link.token, packetaBody(s.items))
    const stored = guestRow(p.order.id).guest_email
    const r = await editLegacy(s.link, p)({ items: twoBags(s), use_parcel_delivery: true, packeta_address: 'Iný bod 7' })
    expect(r.status(), await r.text()).toBe(200)
    expect(editRow(p.order.id)).toMatchObject({ guest_email: stored, packeta_address: 'Iný bod 7', total: 49.8, delivery_fee: 3.5 })

    // `false` / absent never write the e-mail, even on an e-mail-less row (the freeze's only exception is Packeta)
    const v = await submitOk(s.link.token, viaHostBody(s.items))
    for (const extra of [{ use_parcel_delivery: false }, {}, { use_parcel_delivery: null }]) {
      const res = await editCanonical(v)({ items: s.items, guest_email: `gp2.nope.${uniq}@example.test`, ...extra })
      expect(res.status(), JSON.stringify(extra)).toBe(200)
      expect(editRow(v.order.id).guest_email, JSON.stringify(extra)).toBe(null)
    }
  })

  test('Packeta → `false` zeroes the fee and NULLs the point (row read back); `total` stays product-only (both URL forms)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edit2v', { fee: 3.5 })
    for (const form of ['canonical', 'legacy']) {
      const p = await submitOk(s.link.token, packetaBody(s.items))
      const stored = guestRow(p.order.id).guest_email
      const put = form === 'canonical' ? editCanonical(p) : editLegacy(s.link, p)
      // a stray point beside `false` is NOT stored (validateDeliveryChoice's via_host branch)
      const res = await put({ items: twoBags(s), use_parcel_delivery: false, packeta_address: 'Stray 1' })
      expect(res.status(), `${form}: ${await res.text()}`).toBe(200)
      expect(editRow(p.order.id), form).toMatchObject({
        status: 'submitted', total: 49.8, delivery_fee: 0, packeta_address: null, guest_email: stored,
      })
      expect((await res.json()).payment.amount, `${form}: amount = total`).toBe(49.8)
    }
  })

  test('`use_parcel_delivery` absent or `null` ⇒ BOTH columns untouched; stray delivery keys beside it are not written', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edit2abs', { fee: 3.5 })
    const p = await submitOk(s.link.token, packetaBody(s.items))
    for (const extra of [{}, { use_parcel_delivery: null }, { packeta_address: 'Stray 2' }, { use_parcel_delivery: null, packeta_address: '' }]) {
      const res = await editCanonical(p)({ items: twoBags(s), ...extra })
      expect(res.status(), JSON.stringify(extra)).toBe(200)
      expect(editRow(p.order.id), JSON.stringify(extra)).toMatchObject({ total: 49.8, delivery_fee: 3.5, packeta_address: POINT })
    }
    // …and on a via_host row the absent flag keeps it via_host
    const v = await submitOk(s.link.token, viaHostBody(s.items))
    expect((await editLegacy(s.link, v)({ items: twoBags(s), packeta_address: 'Stray 3' })).status()).toBe(200)
    expect(editRow(v.order.id)).toMatchObject({ total: 49.8, delivery_fee: 0, packeta_address: null })
  })

  test('fee changed after submit: 3.50 → 4.00 — a PUT without delivery keys keeps 3.50, a re-save with `true` stores 4.00', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edit2fee', { fee: 3.5 })
    const p = await submitOk(s.link.token, packetaBody(s.items))
    expect((await setCycle(s.cycle.id, { parcel_fee: 4 })).status()).toBe(200)
    const keep = await editCanonical(p)({ items: twoBags(s) })
    expect(keep.status()).toBe(200)
    expect(editRow(p.order.id)).toMatchObject({ total: 49.8, delivery_fee: 3.5 })
    expect((await keep.json()).payment.amount, 'the stored fee is charged, not the new one').toBe(53.3)
    // an UNCHANGED method still re-reads the fee when the PUT carries `true` (resolved conflict 4)
    const resave = await editLegacy(s.link, p)({ items: twoBags(s), use_parcel_delivery: true, packeta_address: POINT })
    expect(resave.status()).toBe(200)
    expect(editRow(p.order.id)).toMatchObject({ total: 49.8, delivery_fee: 4, packeta_address: POINT })
    expect((await resave.json()).payment.amount).toBe(53.8)
    // the admin figure is rounded at ITS write; the edit charges roundMoney(parcel_fee)
    expect((await setCycle(s.cycle.id, { parcel_fee: 3.456 })).status()).toBe(200)
    expect((await editCanonical(p)({ items: s.items, use_parcel_delivery: true, packeta_address: POINT })).status()).toBe(200)
    expect(editRow(p.order.id).delivery_fee).toBe(3.46)
  })

  test('parcels switched OFF after the guest chose Packeta: the stored fee survives; `true` ⇒ 400 + row unchanged; `false` clears', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edit2off', { fee: 3.5 })
    const p = await submitOk(s.link.token, packetaBody(s.items))
    const v = await submitOk(s.link.token, viaHostBody(s.items))
    expect((await setCycle(s.cycle.id, { parcel_enabled: false })).status()).toBe(200)
    const before = editRow(p.order.id)
    expect(before).toMatchObject({ delivery_fee: 3.5, packeta_address: POINT })

    for (const [label, o, put] of [['Packeta row, canonical', p, editCanonical(p)], ['via_host row, legacy', v, editLegacy(s.link, v)]]) {
      const snapshot = editRow(o.order.id)
      const res = await put({ items: twoBags(s), use_parcel_delivery: true, packeta_address: POINT, guest_email: `gp2.off.${uniq}@example.test` })
      expect(res.status(), label).toBe(400)
      expect(await res.json(), label).toEqual({ error: ERR_PARCEL_OFF, field: 'use_parcel_delivery' })
      expect(editRow(o.order.id), `${label}: row unchanged (items and e-mail included)`).toEqual(snapshot)
    }
    // an items-only save keeps the now-unavailable Packeta state (the admin corrects it — UC-GP-009)
    expect((await editCanonical(p)({ items: twoBags(s) })).status()).toBe(200)
    expect(editRow(p.order.id)).toMatchObject({ delivery_fee: 3.5, packeta_address: POINT, total: 49.8 })
    // the UI then sends `false`, which clears both
    expect((await editLegacy(s.link, p)({ items: s.items, use_parcel_delivery: false })).status()).toBe(200)
    expect(editRow(p.order.id)).toMatchObject({ delivery_fee: 0, packeta_address: null, total: 24.9 })
  })

  test('PAID ⇒ the method is frozen with the items: `items` + `false` / `true` ⇒ 409 `paid`, fee kept (both URL forms)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edit2paid', { fee: 3.5 })
    const p = await submitOk(s.link.token, packetaBody(s.items))
    const v = await submitOk(s.link.token, viaHostBody(s.items))
    for (const o of [p, v]) expect((await setPaid(o.order.id, true)).status()).toBe(200)
    const cases = [
      ['Packeta → false, canonical', p, editCanonical(p), { items: s.items, use_parcel_delivery: false }],
      ['Packeta → true (new point), legacy', p, editLegacy(s.link, p), { items: s.items, use_parcel_delivery: true, packeta_address: 'Iný bod' }],
      ['via_host → true, canonical', v, editCanonical(v), { items: s.items, use_parcel_delivery: true, packeta_address: POINT, guest_email: `gp2.paid.${uniq}@example.test` }],
      // the paid gate comes BEFORE the delivery block: an invalid flag on a paid row is still a 409
      ['invalid flag, legacy', v, editLegacy(s.link, v), { items: s.items, use_parcel_delivery: 'true' }],
    ]
    for (const [label, o, put, data] of cases) {
      const snapshot = editRow(o.order.id)
      const res = await put(data)
      expect(res.status(), label).toBe(409)
      expect((await res.json()).reason, label).toBe('paid')
      expect(editRow(o.order.id), `${label}: row unchanged`).toEqual(snapshot)
    }
    expect(editRow(p.order.id)).toMatchObject({ delivery_fee: 3.5, packeta_address: POINT, delivery_fee_paid: 3.5 })
    expect(editRow(v.order.id)).toMatchObject({ delivery_fee: 0, packeta_address: null, guest_email: null })
  })

  test('a CANCEL body ignores delivery keys — never validated, never written (paid and unpaid rows)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edit2cancel', { fee: 3.5 })
    const garbage = [
      { use_parcel_delivery: 'true', packeta_address: 5, guest_email: { x: 1 } },
      { use_parcel_delivery: false },
      { use_parcel_delivery: true, packeta_address: 'Nový bod', guest_email: `gp2.cancel.${uniq}@example.test` },
    ]
    for (const [i, extra] of garbage.entries()) {
      const paid = i === 0
      const o = await submitOk(s.link.token, i === 2 ? viaHostBody(s.items) : packetaBody(s.items))
      if (paid) expect((await setPaid(o.order.id, true)).status()).toBe(200)
      const before = editRow(o.order.id)
      expect(before.packeta_address, 'non-vacuity: the Packeta rows have a point to keep').toBe(i === 2 ? null : POINT)
      const put = i % 2 ? editLegacy(s.link, o) : editCanonical(o)
      const res = await put({ items: [], ...extra })
      expect(res.status(), `${JSON.stringify(extra)}: ${await res.text()}`).toBe(200)
      expect(editRow(o.order.id), JSON.stringify(extra)).toMatchObject({
        status: 'cancelled', total: 0, delivery_fee: 0,
        packeta_address: before.packeta_address, guest_email: before.guest_email, // KEPT — nothing written
      })
    }
  })

  test('the edit 400 matrix: each refusal names its field, says the exact message, and leaves the row byte-identical', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edit2matrix', { fee: 3.5 })
    const v = await submitOk(s.link.token, viaHostBody(s.items)) // e-mail-less, so the e-mail rule bites
    const ok = { items: twoBags(s), use_parcel_delivery: true, packeta_address: POINT, guest_email: `gp2.m.${uniq}@example.test` }
    const cases = [
      [{ use_parcel_delivery: 'true' }, ERR_METHOD, 'use_parcel_delivery'],
      [{ use_parcel_delivery: 'false' }, ERR_METHOD, 'use_parcel_delivery'],
      [{ use_parcel_delivery: 1 }, ERR_METHOD, 'use_parcel_delivery'],
      [{ use_parcel_delivery: 0 }, ERR_METHOD, 'use_parcel_delivery'],
      [{ use_parcel_delivery: [true] }, ERR_METHOD, 'use_parcel_delivery'],
      [{ use_parcel_delivery: {} }, ERR_METHOD, 'use_parcel_delivery'],
      [{ packeta_address: undefined }, ERR_ADDRESS_MISSING, 'packeta_address'],
      [{ packeta_address: '   ' }, ERR_ADDRESS_MISSING, 'packeta_address'],
      [{ packeta_address: 15 }, ERR_ADDRESS_MISSING, 'packeta_address'],
      [{ packeta_address: { a: 1 } }, ERR_ADDRESS_MISSING, 'packeta_address'],
      [{ packeta_address: ['x'] }, ERR_ADDRESS_MISSING, 'packeta_address'],
      [{ packeta_address: 'x'.repeat(161) }, ERR_ADDRESS_LONG, 'packeta_address'],
      [{ guest_email: undefined }, ERR_EMAIL_MISSING, 'guest_email'],
      [{ guest_email: null }, ERR_EMAIL_MISSING, 'guest_email'],
      [{ guest_email: '   ' }, ERR_EMAIL_MISSING, 'guest_email'],
      [{ guest_email: 'x' }, ERR_EMAIL_SHAPE, 'guest_email'],
      [{ guest_email: 5 }, ERR_EMAIL_SHAPE, 'guest_email'],
      [{ guest_email: ['a@b.sk'] }, ERR_EMAIL_SHAPE, 'guest_email'],
      [{ guest_email: `${'a'.repeat(150)}@example.sk` }, ERR_EMAIL_LONG, 'guest_email'],
      // gate order: the delivery block runs BEFORE pricing (as on the submit)
      [{ use_parcel_delivery: 'x', items: [{ ...s.items[0], quantity: 101 }] }, ERR_METHOD, 'use_parcel_delivery'],
    ]
    const snapshot = editRow(v.order.id)
    for (const [i, [override, error, field]] of cases.entries()) {
      const data = { ...ok, ...override }
      for (const k of Object.keys(override)) if (override[k] === undefined) delete data[k]
      const res = await (i % 2 ? editLegacy(s.link, v) : editCanonical(v))(data)
      const label = JSON.stringify(override).slice(0, 80)
      expect(res.status(), label).toBe(400)
      expect(await res.json(), label).toEqual({ error, field })
      expect(editRow(v.order.id), `${label}: row unchanged`).toEqual(snapshot)
    }
    // non-vacuity: the SAME body without an override is accepted
    expect((await editCanonical(v)(ok)).status()).toBe(200)
    expect(editRow(v.order.id)).toMatchObject({ delivery_fee: 3.5, packeta_address: POINT, guest_email: ok.guest_email })
    // exactly 160 chars (after trim) of point and of e-mail are accepted
    const w = await submitOk(s.link.token, viaHostBody(s.items))
    const email160 = `${'b'.repeat(149)}@example.sk`
    expect(email160).toHaveLength(160)
    const edge = await editLegacy(s.link, w)({ items: s.items, use_parcel_delivery: true, packeta_address: ` ${'p'.repeat(160)} `, guest_email: email160 })
    expect(edge.status(), await edge.text()).toBe(200)
    expect(editRow(w.order.id)).toMatchObject({ packeta_address: 'p'.repeat(160), guest_email: email160 })
  })

  test('unbindable WHOLE bodies ({} / true / [1] / "abc") on the edit answer 400, never 500, and write nothing', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('edit2shape', { fee: 3.5 })
    const p = await submitOk(s.link.token, packetaBody(s.items))
    const snapshot = editRow(p.order.id)
    const raws = ['{}', 'true', '[1]', '[true]', '"abc"', 'abc',
      '{"use_parcel_delivery":true}', '{"use_parcel_delivery":false,"items":"x"}']
    for (const raw of raws) {
      const res = await ctx.put(`/api/guest/o/${p.order.order_token}`, {
        headers: { 'Content-Type': 'application/json' },
        data: raw,
      })
      expect(res.status(), raw).toBe(400)
      expect(editRow(p.order.id), raw).toEqual(snapshot)
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
    // ⚠ GP-T2: the original `[^;\n]*` matched the edit's spec-mandated statement (20
    // §UC-GP-005 rule 4: `SET total = ?, status = 'submitted', delivery_fee = ?, …`), and
    // a plain `[^,;\n]` then missed folds with a comma INSIDE the expression
    // (`ROUND(?, 2) + delivery_fee` — review). So the scan cuts only at a comma that
    // STARTS THE NEXT ASSIGNMENT (`, <col> =`).
    const FOLD = /total\s*=\s*(?:(?!,\s*\w+\s*=)[^;\n])*delivery_fee/
    expect(guest, 'no write folds the fee into total').not.toMatch(FOLD)
    for (const fold of ['total = ? + delivery_fee', 'total = ROUND(?, 2) + delivery_fee', 'total = MAX(?, 0) + delivery_fee']) {
      expect(fold, 'non-vacuity: the pin still sees a fold').toMatch(FOLD)
    }
    expect("SET total = ?, status = 'submitted', delivery_fee = ?, packeta_address = ? WHERE id = ?",
      'the spec statement is NOT a fold').not.toMatch(FOLD)
    const helper = stripComments(readBackend('helpers/guest-orders.js'))
    expect(helper).toMatch(/UPDATE guest_orders\s+SET status = 'cancelled', total = 0, delivery_fee = 0,/)
    expect(helper, 'the address is the record — never cleared by cancel').not.toMatch(/packeta_address\s*=\s*NULL/)
  })

  test('GP-T2: the EDIT re-reads the fee in its transaction, writes literal columns, and the e-mail write is write-once', () => {
    const guest = stripComments(readBackend('routes/guest.js'))
    const start = guest.indexOf('function handleStatusEdit(')
    const end = guest.indexOf('function handleInviteRequest(')
    expect(start, 'the edit handler was found').toBeGreaterThan(-1)
    expect(end, 'the next handler was found').toBeGreaterThan(start)
    const edit = guest.slice(start, end)
    expect(edit, 'readability gate: the slice reaches the response').toContain('res.json(statusPayload(link, cycle, loadOrder(order.id)))')
    // the SAME validator as the submit (one home), never a second copy
    expect(edit).toContain('validateDeliveryChoice(req.body, cycle)')
    // the fee is read WITH the status, INSIDE db.transaction, and THAT read is charged
    expect(edit).toMatch(/db\.transaction\(\(\) => \{[\s\S]*?SELECT status, parcel_fee FROM order_cycles WHERE id = \?[\s\S]*?const deliveryFee = delivery\.packeta \? roundMoney\(Number\(current\.parcel_fee\) \|\| 0\) : 0;/)
    expect(edit, 'the resolver row never prices the edit').not.toMatch(/cycle\.parcel_fee/)
    // literal columns in ONE statement with the items write (rule 4), bound by name
    expect(edit).toContain("UPDATE guest_orders SET total = ?, status = 'submitted', delivery_fee = ?, packeta_address = ? WHERE id = ?")
    expect(edit).toContain('.run(total, deliveryFee, delivery.address, order.id)')
    // the items-only write (absent flag ⇒ untouched) is still there
    expect(edit).toContain(`UPDATE guest_orders SET total = ?, status = 'submitted' WHERE id = ?`)
    // the write-once predicate IS the guard (D3)
    expect(edit).toContain('UPDATE guest_orders SET guest_email = ? WHERE id = ? AND guest_email IS NULL')
    expect(guest.match(/guest_email\s*=/g), 'guest_email is SET in exactly one place in the public route').toHaveLength(1)
    expect(edit, 'never a spread body').not.toMatch(/\.\.\.\s*req\.body/)
    expect(edit, 'no ledger').not.toMatch(/transactions/)
  })

  test('the new guest-facing server strings never say „cyklus"/„kolo" (e2e/helpers/vocabulary.js BANNED)', () => {
    for (const s of [ERR_METHOD, ERR_PARCEL_OFF, ERR_ADDRESS_MISSING, ERR_ADDRESS_LONG, ERR_EMAIL_MISSING,
      MAIL_DELIVERY_LABEL, MAIL_PACKETA_LABEL]) {
      expect(s).not.toMatch(BANNED)
      expect(readBackend('routes/guest.js'), `the route really carries „${s}"`).toContain(s.replace(' (najviac 160 znakov)', ''))
    }
  })
})


// ═════════════════════════════════════════════════════════════════════════════
// §9 GP-T3 · 20 §UC-GP-003 (checkout delivery choice) + §UC-GP-004's g-confirm half
// ═════════════════════════════════════════════════════════════════════════════
// Real UI against the shared target: `scenario()` builds a parcel-capable (or, with
// `parcel: false`, a parcel-off) open round, so no payload is mocked here — every
// state this row renders is reachable. ⚠ DRAFT PO copy (staging sign-off, PO
// 2026-09-19), hoisted so sign-off is a two-place edit (these + the two .vue files).
const GP3_PHONE = { width: 378, height: 900 }
const GP3_FEE_BADGE = 'Packeta +3.50 EUR'
const GP3_GROUP_LBL = 'Spôsob prevzatia'
const GP3_VIA_HOST = (host) => `Prevezmem od ${host}`
// ORCHESTRATOR DECISION (GP-T3 review): `fmtEur` — one fee, one format with the hero badge.
const GP3_PACKETA = 'Poslať Packetou (+3.50 EUR)'
const GP3_POINT_LBL = 'Výdajné miesto Packeta *'
const GP3_POINT_PH = 'napr. Z-BOX Hlavná 15, Bratislava'
const GP3_POINT_HELP = (host) => `Názov Z-BOXu alebo pobočky a mesto. Balík vám doručí Packeta, nie ${host}.`
const GP3_EMAIL_OPT = 'E-mail (nepovinné)'
const GP3_EMAIL_REQ = 'E-mail *'
const GP3_EMAIL_HELP = 'Packeta vám naň pošle informácie o zásielke.'
const GP3_SUB_HOST = (amount, host) => `Suma na úhradu: ${amount}. Platba prevodom, tovar vám odovzdá ${host}.`
const GP3_SUB_PACKETA = (amount) => `Suma na úhradu: ${amount}. Platba prevodom, balík vám doručí Packeta.`
const GP3_MSG_POINT = 'Zadajte výdajné miesto Packety.'
const GP3_MSG_EMAIL = 'Pri doručení Packetou zadajte e-mail.'
const GP3_MSG_SHAPE = 'Zadajte platný e-mail.'
const GP3_STEP3_OFF = (host) => `Od ${host}.`
const GP3_STEP3_ON = (host) => `Od ${host}, alebo si ju nechajte poslať cez Packetu.`
const GP3_CONFIRM_POINT = (point) => `Balík vám doručí Packeta: ${point}`

async function gp3Page(page, label, opts = {}) {
  const s = await scenario(label, opts)
  await page.setViewportSize(opts.viewport || GP3_PHONE)
  await page.goto(`/g/${s.link.token}`)
  const hero = page.locator('.app .card.hl')
  await expect(hero.locator('h1.h-screen')).toHaveText(s.cycle.name)
  return { ...s, hero, first: s.host.name.split(' ')[0] }
}

async function gp3OpenCheckout(page, s) {
  await page.getByTestId(`product-${s.product.id}`).getByTestId('inc-250g').click()
  await page.getByTestId('open-checkout').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.m-title')).toHaveText('Dokončiť objednávku')
  return dialog
}

// The row label wraps the (clip-hidden) native radio — a tap on the ROW is the real
// gesture (FriendOrder's RadioRow recipe), so that is what the tests click.
// (`has` resolves RELATIVE to the row, so the inner locator must not carry the dialog.)
const gp3Row = (dialog, testid) => dialog.locator('label.radiorow', { has: dialog.page().getByTestId(testid) })
const gp3ChoosePacketa = (dialog) => gp3Row(dialog, 'guest-delivery-packeta').click()
const gp3ChooseViaHost = (dialog) => gp3Row(dialog, 'guest-delivery-via-host').click()

// `.m-body`'s element children, each named by the testid of the control it holds.
const gp3BodyShape = (dialog) => dialog.locator('.m-body').evaluate((el) => [...el.children].map((c) => {
  const own = c.getAttribute('data-testid')
  if (own) return own
  const inner = c.querySelector('[data-testid]')
  return `${c.tagName.toLowerCase()}:${inner ? inner.getAttribute('data-testid') : c.className}`
}))

const isSubmit = (r) => r.method() === 'POST' && /\/api\/guest\/[^/]+\/orders$/.test(new URL(r.url()).pathname)

test.describe('GP-T3 · 20 §UC-GP-003 — lib/email-shape.js is the mailer\'s regex', () => {
  test('⚠ the client EMAIL_SHAPE mirrors backend/src/helpers/mailer.js EMAIL_SHAPE byte for byte (both imported in node)', async () => {
    test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)
    const { EMAIL_SHAPE: SERVER } = await import(srcUrl('helpers/mailer.js'))
    expect(SERVER, 'non-vacuity: the server really exports it').toBeInstanceOf(RegExp)
    expect(CLIENT_EMAIL_SHAPE).toBeInstanceOf(RegExp)
    expect(CLIENT_EMAIL_SHAPE.source).toBe(SERVER.source)
    expect(CLIENT_EMAIL_SHAPE.flags).toBe(SERVER.flags)
    // …and they agree on a matrix that exercises every class of the pattern.
    const cases = ['a@b.sk', 'meno.priezvisko@firma.example.test', 'x', 'a@b', '@b.sk', 'a b@c.sk', 'a@b.c;d', 'a,b@c.sk', 'a@@b.sk', '']
    const verdicts = cases.map((c) => [c, CLIENT_EMAIL_SHAPE.test(c)])
    expect(verdicts).toEqual(cases.map((c) => [c, SERVER.test(c)]))
    expect(verdicts.filter(([, ok]) => ok).length, 'non-vacuity: both verdicts occur').toBe(2)
  })
})

test.describe('GP-T3 · 20 §UC-GP-003 — a parcel-OFF round renders today\'s page', () => {
  test('no hero badge, no delivery controls, the shipped e-mail label and subtitle, step 3 without the clause', async ({ page }) => {
    const s = await gp3Page(page, 'UiOff', { parcel: false })
    const listing = await (await ctx.get(`/api/guest/${s.link.token}`)).json()
    expect(listing.cycle.parcel_enabled, 'non-vacuity: parcels really are off').toBe(0)

    await expect(s.hero.locator('.badge')).toHaveCount(3)
    await expect(page.getByTestId('guest-hero-packeta')).toHaveCount(0)
    await s.hero.getByTestId('guest-steps-toggle').click()
    await expect(s.hero.getByTestId('guest-steps-detail').getByTestId('guest-step-detail').nth(2)).toHaveText(GP3_STEP3_OFF(s.first))

    const dialog = await gp3OpenCheckout(page, s)
    // ⚠ The DOM is element-for-element today's: exactly the three shipped fields.
    expect(await gp3BodyShape(dialog)).toEqual(['div:guest-name', 'div:guest-phone', 'div:guest-email'])
    await expect(dialog.getByTestId('guest-delivery-choice')).toHaveCount(0)
    await expect(dialog.locator('input[type="radio"]')).toHaveCount(0)
    await expect(dialog.getByTestId('guest-packeta-address')).toHaveCount(0)
    await expect(dialog.getByText(GP3_GROUP_LBL)).toHaveCount(0)
    await expect(dialog.locator('.field-help')).toHaveCount(0)
    await expect(dialog.locator('label.field-lbl[for="guest-email"]')).toHaveText(GP3_EMAIL_OPT)
    await expect(dialog.locator('.m-head .sub')).toHaveText(GP3_SUB_HOST('24.90 EUR', s.first))
  })
})

test.describe('GP-T3 · 20 §UC-GP-003 — the delivery choice on a parcel-ON round', () => {
  test('the hero gains a fourth `.badge.acc-o` „Packeta +{fee}" and step 3 gains its Packeta clause', async ({ page }) => {
    const s = await gp3Page(page, 'UiHero')
    const badges = s.hero.locator('.badge')
    await expect(badges).toHaveCount(4)
    await expect(badges.nth(3)).toHaveText(GP3_FEE_BADGE)
    await expect(badges.nth(3)).toHaveClass(/\bacc-o\b/)
    await expect(badges.nth(3)).toHaveAttribute('data-testid', 'guest-hero-packeta')
    // The shipped three are untouched, in order.
    await expect(badges.nth(0)).toHaveText('Login netreba')
    await expect(badges.nth(2)).toHaveText(`Tovar odovzdá ${s.first}`)

    await s.hero.getByTestId('guest-steps-toggle').click()
    await expect(s.hero.getByTestId('guest-steps-detail').getByTestId('guest-step-detail').nth(2)).toHaveText(GP3_STEP3_ON(s.first))
    // The compact strip renders no details either way.
    await expect(s.hero.getByTestId('guest-steps-compact').getByTestId('guest-step-detail')).toHaveCount(0)
  })

  test('the choice sits below Mobil and above E-mail, defaults to via_host, and Packeta reveals the point + flips the e-mail label and subtitle', async ({ page }) => {
    const s = await gp3Page(page, 'UiChoice')
    const dialog = await gp3OpenCheckout(page, s)
    expect(await gp3BodyShape(dialog)).toEqual(['div:guest-name', 'div:guest-phone', 'guest-delivery-choice', 'div:guest-email'])

    const choice = dialog.getByTestId('guest-delivery-choice')
    await expect(choice.locator('span.field-lbl')).toHaveText(GP3_GROUP_LBL)
    await expect(choice.locator('label.radiorow')).toHaveText([GP3_VIA_HOST(s.first), GP3_PACKETA])
    await expect(dialog.getByTestId('guest-delivery-via-host')).toBeChecked()
    await expect(dialog.getByTestId('guest-delivery-packeta')).not.toBeChecked()
    // The two radios are ONE native group (arrow keys, one Tab stop).
    await expect(dialog.locator('input[type="radio"][name="guest-delivery-method"]')).toHaveCount(2)
    await expect(dialog.getByTestId('guest-packeta-address')).toHaveCount(0)
    await expect(dialog.locator('label.field-lbl[for="guest-email"]')).toHaveText(GP3_EMAIL_OPT)
    await expect(dialog.locator('.m-head .sub')).toHaveText(GP3_SUB_HOST('24.90 EUR', s.first))

    await gp3ChoosePacketa(dialog)
    await expect(dialog.getByTestId('guest-delivery-packeta')).toBeChecked()
    const point = dialog.getByTestId('guest-packeta-address')
    await expect(point).toBeVisible()
    await expect(point).toHaveClass('inp')
    await expect(point).toHaveAttribute('maxlength', '160')
    await expect(point).toHaveAttribute('placeholder', GP3_POINT_PH)
    await expect(point).toHaveAttribute('id', 'guest-packeta-address')
    await expect(dialog.locator('label.field-lbl[for="guest-packeta-address"]')).toHaveText(GP3_POINT_LBL)
    await expect(choice.locator('.field-help')).toHaveText(GP3_POINT_HELP(s.first))

    await expect(dialog.locator('label.field-lbl[for="guest-email"]')).toHaveText(GP3_EMAIL_REQ)
    await expect(dialog.getByTestId('guest-email-help')).toHaveText(GP3_EMAIL_HELP)
    await expect(dialog.getByTestId('guest-email')).toHaveAttribute('maxlength', '160')
    await expect(dialog.locator('.m-head .sub')).toHaveText(GP3_SUB_PACKETA('28.40 EUR'))
    await expect(dialog.locator('.m-head .sub b')).toHaveClass(/\bmono\b/)
    // ⚠ PO: the cartbar stays PRODUCT-ONLY — it is the cart, not the invoice.
    await expect(page.getByTestId('cart-total')).toHaveText('Celkom: 24.90 EUR')

    // And back: nothing of the Packeta branch survives on screen.
    await gp3ChooseViaHost(dialog)
    await expect(dialog.getByTestId('guest-packeta-address')).toHaveCount(0)
    await expect(dialog.getByTestId('guest-email-help')).toHaveCount(0)
    await expect(dialog.locator('label.field-lbl[for="guest-email"]')).toHaveText(GP3_EMAIL_OPT)
    await expect(dialog.locator('.m-head .sub')).toHaveText(GP3_SUB_HOST('24.90 EUR', s.first))
  })

  test('the modal resets to via_host and an empty point on every open (item 7)', async ({ page }) => {
    const s = await gp3Page(page, 'UiReset')
    let dialog = await gp3OpenCheckout(page, s)
    await gp3ChoosePacketa(dialog)
    await dialog.getByTestId('guest-packeta-address').fill('Z-BOX Stará 1, Trnava')
    await dialog.getByRole('button', { name: 'Späť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.getByTestId('open-checkout').click()
    dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('guest-delivery-via-host')).toBeChecked()
    await expect(dialog.getByTestId('guest-packeta-address')).toHaveCount(0)
    await gp3ChoosePacketa(dialog)
    await expect(dialog.getByTestId('guest-packeta-address')).toHaveValue('')
  })

  test('at 320px the Packeta branch overflows nothing — not the document, not the scrim, not the body', async ({ page }) => {
    const s = await gp3Page(page, 'Ui320', { viewport: { width: 320, height: 700 } })
    const dialog = await gp3OpenCheckout(page, s)
    await gp3ChoosePacketa(dialog)
    await expect(dialog.getByTestId('guest-packeta-address')).toBeVisible()
    const over = await page.evaluate(() => {
      const layer = document.querySelector('.modal-scrim')
      const all = [layer, ...layer.querySelectorAll('*')]
      return {
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        spills: all.filter((el) => el.scrollWidth - el.clientWidth > 1 && getComputedStyle(el).overflowX !== 'visible')
          .map((el) => el.className || el.tagName),
      }
    })
    expect(over.doc).toBe(0)
    expect(over.spills, 'no scroller inside the modal layer absorbs a spill').toEqual([])
  })

  test('the three client messages fire WITHOUT a request, then a valid Packeta checkout goes out once', async ({ page }) => {
    const s = await gp3Page(page, 'UiMsgs')
    const posts = []
    page.on('request', (r) => { if (isSubmit(r)) posts.push(r) })
    const dialog = await gp3OpenCheckout(page, s)
    await dialog.getByTestId('guest-name').fill('Zuzana Packetová')
    await dialog.getByTestId('guest-phone').fill(uniquePhone())
    await gp3ChoosePacketa(dialog)
    const err = dialog.getByTestId('checkout-error')
    const submitBtn = dialog.getByTestId('guest-submit')

    await submitBtn.click()
    await expect(err).toHaveText(GP3_MSG_POINT)
    await dialog.getByTestId('guest-packeta-address').fill('    ')
    await submitBtn.click()
    await expect(err, 'a blank point is a missing point (trimmed)').toHaveText(GP3_MSG_POINT)

    await dialog.getByTestId('guest-packeta-address').fill('Z-BOX Hlavná 15, Bratislava')
    await submitBtn.click()
    await expect(err).toHaveText(GP3_MSG_EMAIL)
    await dialog.getByTestId('guest-email').fill('   ')
    await submitBtn.click()
    await expect(err).toHaveText(GP3_MSG_EMAIL)

    for (const bad of ['x', 'a@b', 'a b@c.sk']) {
      await dialog.getByTestId('guest-email').fill(bad)
      await submitBtn.click()
      await expect(err, `„${bad}" fails the mirrored EMAIL_SHAPE`).toHaveText(GP3_MSG_SHAPE)
    }
    // ⚠ Give a stray request time to be dispatched before counting its absence.
    await page.waitForTimeout(500)
    expect(posts, 'no message above cost a request').toHaveLength(0)
    await expect(dialog.getByTestId('guest-submit'), 'non-vacuity: still on the modal').toBeVisible()

    await dialog.getByTestId('guest-email').fill(`gp3.${uniq}.${++phoneSeq}@example.test`)
    await submitBtn.click()
    await expect(page.getByTestId('guest-confirmation')).toBeVisible()
    expect(posts, 'non-vacuity: the gate counts real submits').toHaveLength(1)
  })

  test('⚠ a via_host submit on a parcel-ON round sends NO delivery keys — even after Packeta was chosen and typed into', async ({ page }) => {
    const s = await gp3Page(page, 'UiViaHost')
    const dialog = await gp3OpenCheckout(page, s)
    await expect(dialog.getByTestId('guest-delivery-choice'), 'non-vacuity: the choice IS offered').toBeVisible()
    await dialog.getByTestId('guest-name').fill('Zuzana Odovzdaná')
    await dialog.getByTestId('guest-phone').fill(uniquePhone())
    await gp3ChoosePacketa(dialog)
    await dialog.getByTestId('guest-packeta-address').fill('Z-BOX Hlavná 15, Bratislava')
    await gp3ChooseViaHost(dialog)

    const [req, resp] = await Promise.all([
      page.waitForRequest(isSubmit),
      page.waitForResponse((r) => isSubmit(r.request())),
      dialog.getByTestId('guest-submit').click(),
    ])
    const body = req.postDataJSON()
    expect(Object.keys(body).sort(), 'the shipped payload, byte for byte').toEqual(['guest_name', 'guest_phone', 'items'])
    expect(resp.status()).toBe(201)
    const result = await resp.json()
    expect(result.payment.amount).toBe(24.9)

    const confirm = page.getByTestId('guest-confirmation')
    await expect(confirm).toBeVisible()
    // The Platba modal opens by itself (the seed configures an IBAN) — close it first.
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText('Platba')
    await page.getByRole('dialog').getByRole('button', { name: 'Zavrieť' }).first().click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const card = confirm.locator('.card', { hasText: 'Suma na úhradu' })
    await expect(card.locator('span.display')).toHaveText('24.90 EUR')
    await expect(confirm.getByTestId('confirm-delivery-fee')).toHaveCount(0)
    await expect(confirm.getByTestId('confirm-packeta-address')).toHaveCount(0)
    await expect(card.locator('li.ln'), 'non-vacuity: the item line rendered').toHaveCount(1)
    const row = guestRow(result.order.id)
    if (row) {
      expect(row.delivery_fee).toBe(0)
      expect(row.packeta_address).toBeNull()
    }
  })

  test('⚠ a Packeta checkout: payload keys, g-confirm fee line + point, the fee-inclusive amount, and the RENDERED QR encodes total + fee', async ({ page }) => {
    const s = await gp3Page(page, 'UiPacketa')
    const dialog = await gp3OpenCheckout(page, s)
    await dialog.getByTestId('guest-name').fill('Zuzana Packetová')
    await dialog.getByTestId('guest-phone').fill(uniquePhone())
    await gp3ChoosePacketa(dialog)
    await dialog.getByTestId('guest-packeta-address').fill('  Z-BOX Hlavná 15, Bratislava  ')
    const email = `gp3.${uniq}.${++phoneSeq}@example.test`
    await dialog.getByTestId('guest-email').fill(email)

    const [req, resp] = await Promise.all([
      page.waitForRequest(isSubmit),
      page.waitForResponse((r) => isSubmit(r.request())),
      dialog.getByTestId('guest-submit').click(),
    ])
    const body = req.postDataJSON()
    expect(Object.keys(body).sort()).toEqual(['guest_email', 'guest_name', 'guest_phone', 'items', 'packeta_address', 'use_parcel_delivery'])
    expect(body.use_parcel_delivery, 'a strict boolean (D1)').toBe(true)
    expect(body.packeta_address, 'trimmed on the client too').toBe('Z-BOX Hlavná 15, Bratislava')
    expect(body.guest_email).toBe(email)
    expect(resp.status(), await resp.text()).toBe(201)
    const result = await resp.json()
    expect(result.payment.amount, '24.90 + 3.50').toBe(28.4)
    expect(result.payment.iban, 'non-vacuity: the seed configures payment settings').toBeTruthy()

    // The row, read back — the response is not evidence of what was stored.
    const row = guestRow(result.order.id)
    if (row) {
      expect(row.total).toBe(24.9)
      expect(row.delivery_fee).toBe(3.5)
      expect(row.packeta_address).toBe('Z-BOX Hlavná 15, Bratislava')
    }

    // §UC-GSO-003: the Platba modal opens by itself — its QR is what a bank app scans.
    const pay = page.getByRole('dialog')
    await expect(pay.locator('.m-title')).toHaveText('Platba')
    await expect(pay.getByAltText('Pay by Square QR')).toBeVisible()
    const scanned = await readQrModules(page)
    expect(scanned.error).toBeUndefined()
    const expected = independentQr(
      28.4,
      result.payment.reference,
      result.payment.iban,
      result.payment.variable_symbol,
      result.payment.creditor_name || 'Gorifi',
    )
    expect(scanned.size).toBe(expected.size)
    expect(scanned.matrix, 'the scanned code IS the independent encode of total + fee').toBe(expected.matrix)
    // Non-vacuity: a product-only encode is a DIFFERENT code — the fee is really in it.
    const productOnly = independentQr(24.9, result.payment.reference, result.payment.iban,
      result.payment.variable_symbol, result.payment.creditor_name || 'Gorifi')
    expect(scanned.matrix).not.toBe(productOnly.matrix)
    const decoded = decodeBySquare(expected.qrString).payments[0]
    expect(decoded.amount).toBe(28.4)
    // The reference is unchanged by the fee (R4.2) — SERVER-owned, never composed here.
    expect(decoded.paymentNote).toBe(result.payment.reference)
    expect(result.payment.reference).toBe(`G${result.order.id} / Zuzana Packetová / ${s.cycle.name}`)
    expect(decoded.beneficiary.name).toBe(result.payment.creditor_name || 'Gorifi')

    await pay.getByRole('button', { name: 'Zavrieť' }).first().click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // g-confirm (§UC-GP-004): the fee is its OWN line after the items, and the sum is
    // the server's fee-inclusive `payment.amount`.
    const confirm = page.getByTestId('guest-confirmation')
    const card = confirm.locator('.card', { hasText: 'Suma na úhradu' })
    await expect(card.locator('span.display')).toHaveText('28.40 EUR')
    const lines = card.locator('li.ln')
    await expect(lines).toHaveCount(2)
    const fee = card.getByTestId('confirm-delivery-fee')
    await expect(fee).toHaveCount(1)
    await expect(lines.nth(1), 'after the item line').toHaveAttribute('data-testid', 'confirm-delivery-fee')
    await expect(fee.locator('.ln-name')).toHaveText('Doručenie Packetou')
    await expect(fee.locator('.ln-amt')).toHaveText('3.50 €')
    await expect(fee.locator('.ln-amt')).toHaveClass(/\bmono\b/)
    const point = confirm.getByTestId('confirm-packeta-address')
    await expect(point).toHaveText(GP3_CONFIRM_POINT('Z-BOX Hlavná 15, Bratislava'))
    await expect(point).toHaveClass(/\bsub\b/)
    // ⚠ The point is person-typed: marked for the copy sweep (FUP-T22), the label is not.
    await expect(point.locator('[data-user-copy]')).toHaveText('Z-BOX Hlavná 15, Bratislava')
  })
})

test.describe('GP-T3 · e2e-tester pass — keyboard, touch and the rendered-copy sweep', () => {
  test('keyboard: arrow keys move the native radio group and check it, Space selects a focused radio, Tab then lands on the point field', async ({ page }) => {
    const s = await gp3Page(page, 'UiKbd')
    const dialog = await gp3OpenCheckout(page, s)
    const viaHost = dialog.getByTestId('guest-delivery-via-host')
    const packeta = dialog.getByTestId('guest-delivery-packeta')
    await viaHost.focus()
    await expect(viaHost).toBeFocused()

    await page.keyboard.press('ArrowDown')
    await expect(packeta, 'the arrow key moves the native group').toBeChecked()
    await expect(packeta).toBeFocused()
    await expect(dialog.getByTestId('guest-packeta-address'), 'the point field appears').toBeVisible()

    await page.keyboard.press('ArrowUp')
    await expect(viaHost, 'the arrow key cycles back').toBeChecked()
    await expect(dialog.getByTestId('guest-packeta-address')).toHaveCount(0)

    // Space on a freshly-focused radio checks it too — the OTHER documented gesture.
    await packeta.focus()
    await page.keyboard.press('Space')
    await expect(packeta, 'Space selects the focused radio').toBeChecked()

    // A same-`name` native group has exactly ONE Tab stop (the checked radio); Tab
    // from it lands on the very next control, the point field.
    await page.keyboard.press('Tab')
    await expect(dialog.getByTestId('guest-packeta-address'), 'one Tab stop for the group, then the point field').toBeFocused()
  })

  test('A12: under `pointer: coarse` the Packeta point input computes 16px (no iOS focus zoom)', async ({ browser, baseURL }) => {
    const coarse = await browser.newContext({ baseURL, viewport: GP3_PHONE, hasTouch: true, isMobile: true })
    try {
      const page = await coarse.newPage()
      const s = await gp3Page(page, 'UiCoarse')
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'non-vacuity: the context IS coarse').toBe(true)
      const dialog = await gp3OpenCheckout(page, s)
      await gp3ChoosePacketa(dialog)
      await expect(dialog.getByTestId('guest-packeta-address')).toHaveCSS('font-size', '16px')
    } finally {
      await coarse.close()
    }
  })

  test('the rendered copy sweep: the open Packeta checkout branch and g-confirm\'s fee + point line carry no „cyklus"/„kolo"', async ({ page }) => {
    const s = await gp3Page(page, 'UiVocab')
    const dialog = await gp3OpenCheckout(page, s)
    await dialog.getByTestId('guest-name').fill('Zuzana Slovníková')
    await dialog.getByTestId('guest-phone').fill(uniquePhone())
    await gp3ChoosePacketa(dialog)
    await dialog.getByTestId('guest-packeta-address').fill('Z-BOX Hlavná 15, Bratislava')
    await dialog.getByTestId('guest-email').fill(`gp3.${uniq}.${++phoneSeq}@example.test`)

    // ⚠ CLAUDE.md's `innerText` trap: it applies `text-transform`, and these field
    // labels render UPPERCASE. Case-insensitive, same as `expectCleanCopy`'s idiom.
    let copy = await page.evaluate(collectAppCopy())
    expect(copy.toLowerCase(), 'non-vacuity: the Packeta branch really rendered').toContain('výdajné miesto packeta')
    expect(BANNED.test(copy), `the open Packeta checkout carries a banned word:\n${copy}`).toBe(false)

    await dialog.getByTestId('guest-submit').click()
    await expect(page.getByTestId('guest-confirmation')).toBeVisible()
    // The Platba modal auto-opens (the seed configures an IBAN) — close it before the sweep.
    const pay = page.getByRole('dialog')
    if (await pay.count()) {
      await pay.getByRole('button', { name: 'Zavrieť' }).first().click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
    copy = await page.evaluate(collectAppCopy())
    expect(copy.toLowerCase(), 'non-vacuity: g-confirm really rendered the fee + point line').toContain('doručenie packetou')
    expect(BANNED.test(copy), `g-confirm carries a banned word:\n${copy}`).toBe(false)
  })
})

test.describe('GP-T3 · source pins — one home, and what this row must NOT touch', () => {
  test('GuestDeliveryChoice.vue is the ONE home of the choice; GuestOrder.vue mounts it once and holds no copy', () => {
    test.skip(!HAS_SRC, NEEDS_SRC)
    const view = assertReadable('views/GuestOrder.vue', ['checkout-error', 'guest-email', 'GuestDeliveryChoice'])
    expect(view.match(/<GuestDeliveryChoice\b/g) || [], 'one mount').toHaveLength(1)
    expect(view).toMatch(/import GuestDeliveryChoice from '@\/components\/GuestDeliveryChoice\.vue'/)
    for (const token of ['guest-packeta-address', 'Poslať Packetou', 'Prevezmem od', 'type="radio"']) {
      expect(view, `„${token}" lives in the component, never in the view`).not.toContain(token)
    }
    const comp = assertReadable('components/GuestDeliveryChoice.vue', ['guest-packeta-address', 'parcelEnabled'])
    expect(comp).toContain('maxlength="160"')
    expect(comp, 'renders nothing when parcels are off').toMatch(/<div\s+v-if="parcelEnabled"/)
    for (const s of [GP3_GROUP_LBL, 'Poslať Packetou', 'Prevezmem od', GP3_POINT_LBL, GP3_POINT_PH]) expect(comp).toContain(s)
    for (const s of [GP3_GROUP_LBL, GP3_PACKETA, GP3_POINT_LBL, GP3_POINT_HELP('X'), GP3_EMAIL_HELP, GP3_MSG_POINT,
      GP3_MSG_EMAIL, GP3_MSG_SHAPE, GP3_FEE_BADGE, GP3_SUB_PACKETA('1 EUR'), GP3_CONFIRM_POINT('X')]) {
      expect(s, 'no „cyklus"/„kolo" in the new copy').not.toMatch(BANNED)
    }
  })

  test('EMAIL_SHAPE has ONE client home, and the checkout imports it', () => {
    test.skip(!HAS_SRC, NEEDS_SRC)
    const view = assertReadable('views/GuestOrder.vue', ['checkout-error'])
    expect(view).toMatch(/import \{ EMAIL_SHAPE \} from '@\/lib\/email-shape'/)
    const lib = frontCode('lib/email-shape.js')
    expect(lib, 'readability gate').toContain('export const EMAIL_SHAPE')
    // No second spelling of the pattern anywhere in the frontend.
    const hits = []
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.(vue|js)$/.test(e.name) && readFileSync(full, 'utf8').includes('[^\\s@,;]')) hits.push(relative(REPO_ROOT, full))
      }
    }
    walk(join(REPO_ROOT, 'frontend', 'src'))
    expect(hits).toEqual(['frontend/src/lib/email-shape.js'])
  })

  test('⚠ PaymentModal.vue knows nothing about the fee, and the cartbar total is the product sum', () => {
    test.skip(!HAS_SRC, NEEDS_SRC)
    const modal = assertReadable('components/PaymentModal.vue', ['amount', 'payBySquarePayload'])
    for (const token of ['delivery_fee', 'parcel', 'Packet']) expect(modal, `PaymentModal must not know „${token}"`).not.toContain(token)
    const view = assertReadable('views/GuestOrder.vue', ['cart-total'])
    expect(view).toMatch(/data-testid="cart-total">Celkom: \{\{ fmtEur\(cartTotal\) \}\}</)
    // The Platba modal is fed the SERVER's amount, never a client sum.
    expect(view).toMatch(/:amount="confirmation\.payment\.amount"/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GP-T4 — 20 §UC-GP-007 (the status page: Packeta state, point, edit mode) and
// §UC-GP-008 + §UC-GP-004's host row (`GuestSubOrders.vue`: badge, point, „nemusíte
// nič odovzdávať", no hand-over tick, fee-inclusive foot). UI rows on the shared
// target — every state here is reachable through the real API, so nothing is mocked.
//
// ⚠ PO copy (DRAFT, staging sign-off — PO 2026-09-19), transcribed from the spec and
// hoisted so a sign-off edit is a known two-place change (these + the two .vue files).
// ═════════════════════════════════════════════════════════════════════════════
const GP4_SUB_HOST = (host) => `Vaša objednávka · organizuje a odovzdá ${host}`
const GP4_SUB_PACKETA = (host) => `Vaša objednávka · organizuje ${host} · doručí Packeta`
const GP4_PILL = 'Doručí Packeta'
const GP4_FEE_LINE = 'Doručenie Packetou'
const GP4_POINT_LBL = 'Výdajné miesto Packeta'
const GP4_POINT_SUB = (email) => `Packeta vám pošle informácie o zásielke na ${email}.`
const GP4_PARCEL_GONE = (host) => `Doručenie Packetou už nie je dostupné — objednávku vám odovzdá ${host}.`
const GP4_EDIT_FEE = (fee) => `+ ${fee} doručenie Packetou`
const GP4_HOST_NOTE = 'Tento kolega dostane balík Packetou — nemusíte nič odovzdávať.'
const GP4_BREAKDOWN = (total, fee) => `(${total} + ${fee} doručenie)`

const gp4Email = () => `gp4.${uniq}.${++phoneSeq}@example.test`

/** A guest status page for `order`, on the canonical URL, at the phone width. */
async function gp4Status(page, order) {
  await page.setViewportSize(GP3_PHONE)
  await page.goto(`/g/o/${order.order.order_token}`)
  await expect(page.getByTestId('guest-status')).toBeVisible()
}

/** Every PUT this page sends for `orderToken`, parsed. */
function gp4Writes(page, orderToken) {
  const writes = []
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/guest/') && r.url().includes(orderToken)) {
      writes.push(JSON.parse(r.postData() || 'null'))
    }
  })
  return writes
}

const gp4EditRow = (page, testid) => page.locator('label.radiorow', { has: page.getByTestId(testid) })

test.describe('GP-T4 · 20 §UC-GP-007 — the status page READ view', () => {
  test('a Packeta order: header „doručí Packeta", the pill REPLACES the delivered one, fee line, fee-inclusive total, point card', async ({ page }) => {
    const s = await scenario('gp4read', { fee: 3.5 })
    const email = gp4Email()
    const o = await submitOk(s.link.token, packetaBody(s.items, { guest_email: email }))
    // The host ticks the bag „odovzdané" through the (unchanged) API — the page must
    // STILL not render the delivered pill: the flag is meaningless for a bag the host
    // never holds (§UC-GP-007 item 2; §UC-GP-008 rule 2 — no 409 is added).
    const tick = await ctx.patch(`/api/guest-orders/${o.order.id}/delivered`, { headers: s.host.auth, data: { delivered: true } })
    expect(tick.status(), 'PATCH …/delivered is unchanged server-side').toBe(200)
    const first = s.host.name.split(' ')[0]

    await gp4Status(page, o)
    await expect(page.getByTestId('guest-status').locator('.sub').first()).toHaveText(GP4_SUB_PACKETA(first))

    await expect(page.getByTestId('status-paid'), 'the paid pill is unchanged').toHaveText('Nezaplatené')
    const pill = page.getByTestId('status-packeta')
    await expect(pill).toHaveText(GP4_PILL)
    await expect(pill).toHaveClass(/\bstatuspill\b/)
    await expect(pill).toHaveClass(/\boff\b/)
    await expect(page.getByTestId('status-delivered'), 'no delivered pill on a Packeta order — even once ticked').toHaveCount(0)
    await expect(page.getByText('Odovzdané', { exact: true })).toHaveCount(0)

    const fee = page.getByTestId('status-delivery-fee')
    await expect(fee.locator('.ln-name')).toHaveText(GP4_FEE_LINE)
    await expect(fee.locator('.ln-amt'), 'a fee is a LINE — `€`').toHaveText('3.50 €')
    await expect(page.getByTestId('status-item')).toHaveCount(1)
    await expect(page.getByTestId('status-total'), 'payment.amount = 24.90 + 3.50').toHaveText('28.40 EUR')

    const address = page.getByTestId('status-packeta-address')
    await expect(address).toHaveText(POINT)
    await expect(address, 'person-typed — excluded from copy sweeps').toHaveAttribute('data-user-copy', '')
    const card = page.locator('.card', { has: address })
    await expect(card.locator('.field-lbl')).toHaveText(GP4_POINT_LBL)
    await expect(card.locator('.sub')).toHaveText(GP4_POINT_SUB(email))
  })

  test('a via_host order on a parcel-ON round is today\'s page: shipped header + delivered pill, no fee line, no point card', async ({ page }) => {
    const s = await scenario('gp4host', { fee: 3.5 })
    const o = await submitOk(s.link.token, viaHostBody(s.items))
    const first = s.host.name.split(' ')[0]

    await gp4Status(page, o)
    await expect(page.getByTestId('guest-status').locator('.sub').first()).toHaveText(GP4_SUB_HOST(first))
    await expect(page.getByTestId('status-delivered'), 'non-vacuity: the pills row rendered').toHaveText('Zatiaľ neodovzdané')
    await expect(page.getByTestId('status-packeta')).toHaveCount(0)
    await expect(page.getByTestId('status-total')).toHaveText('24.90 EUR')
    await expect(page.getByTestId('status-delivery-fee')).toHaveCount(0)
    await expect(page.getByTestId('status-packeta-address')).toHaveCount(0)
    await expect(page.getByText(GP4_POINT_LBL, { exact: true })).toHaveCount(0)
  })

  test('a CANCELLED Packeta order keeps its point card (the record); no fee line, no total', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('gp4canc', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    expect((await editCanonical(o)({ items: [] })).status()).toBe(200)
    expect(guestRow(o.order.id)).toMatchObject({ status: 'cancelled', delivery_fee: 0, packeta_address: POINT })

    await gp4Status(page, o)
    await expect(page.getByTestId('status-cancelled')).toBeVisible()
    await expect(page.getByTestId('status-packeta-address')).toHaveText(POINT)
    await expect(page.getByTestId('status-item'), 'non-vacuity: the struck lines rendered').toHaveCount(1)
    await expect(page.getByTestId('status-delivery-fee')).toHaveCount(0)
    await expect(page.getByTestId('status-total')).toHaveCount(0)
  })
})

test.describe('GP-T4 · 20 §UC-GP-007 — the status page EDIT mode', () => {
  test('Packeta → via_host: the card is seeded, the cartbar carries the fee, the save sends `false` and the page drops the point + fee', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('gp4off', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    const first = s.host.name.split(' ')[0]
    const writes = gp4Writes(page, o.order.order_token)

    await gp4Status(page, o)
    await page.getByTestId('start-edit').click()
    const card = page.getByTestId('edit-delivery-card')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('guest-delivery-choice')).toBeVisible()
    await expect(page.getByTestId('guest-delivery-packeta'), 'seeded from order.packeta_address').toBeChecked()
    await expect(page.getByTestId('guest-packeta-address')).toHaveValue(POINT)
    await expect(page.getByTestId('guest-packeta-address')).toHaveAttribute('maxlength', '160')
    await expect(page.getByTestId('edit-guest-email'), 'the order HAS an e-mail — identity stays frozen').toHaveCount(0)
    // Card ABOVE the product grid.
    const cardTop = (await card.boundingBox()).y
    const gridTop = (await page.getByTestId(`product-${s.product.id}`).boundingBox()).y
    expect(cardTop, 'the delivery card sits above the grid').toBeLessThan(gridTop)

    await expect(page.getByTestId('edit-total')).toHaveText('Celkom: 28.40 EUR')
    await expect(page.getByTestId('edit-delivery-fee')).toHaveText(GP4_EDIT_FEE('3.50 EUR'))

    await gp4EditRow(page, 'guest-delivery-via-host').click()
    await expect(page.getByTestId('edit-total')).toHaveText('Celkom: 24.90 EUR')
    await expect(page.getByTestId('edit-delivery-fee')).toHaveCount(0)
    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('guest-status')).toBeVisible()

    expect(writes, 'exactly one write — the delivery block is always sent, `false` here').toEqual([
      { items: [{ product_id: s.product.id, variant: '250g', quantity: 1 }], use_parcel_delivery: false },
    ])
    await expect(page.getByTestId('guest-status').locator('.sub').first()).toHaveText(GP4_SUB_HOST(first))
    await expect(page.getByTestId('status-packeta-address')).toHaveCount(0)
    await expect(page.getByTestId('status-total'), 'the total dropped by the fee').toHaveText('24.90 EUR')
    await expect(page.getByTestId('status-delivered')).toBeVisible()
    expect(guestRow(o.order.id)).toMatchObject({ delivery_fee: 0, packeta_address: null, total: 24.9 })
  })

  test('an e-mail-LESS via_host order switching to Packeta: the write-once „E-mail *" input, three client messages without a request, then one save carrying it', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('gp4mail', { fee: 3.5 })
    const o = await submitOk(s.link.token, viaHostBody(s.items))
    expect(guestRow(o.order.id).guest_email).toBeNull()
    const writes = gp4Writes(page, o.order.order_token)

    await gp4Status(page, o)
    await page.getByTestId('start-edit').click()
    await expect(page.getByTestId('guest-delivery-via-host'), 'seeded via_host').toBeChecked()
    await expect(page.getByTestId('edit-guest-email'), 'via_host — no e-mail input').toHaveCount(0)
    await expect(page.getByTestId('edit-total')).toHaveText('Celkom: 24.90 EUR')

    await gp4EditRow(page, 'guest-delivery-packeta').click()
    const input = page.getByTestId('edit-guest-email')
    await expect(input).toBeVisible()
    await expect(input).toHaveAttribute('maxlength', '160')
    await expect(page.locator('label[for="edit-guest-email"]')).toHaveText(GP3_EMAIL_REQ)
    await expect(page.getByTestId('edit-guest-email-help')).toHaveText(GP3_EMAIL_HELP)
    await expect(page.getByTestId('edit-total')).toHaveText('Celkom: 28.40 EUR')

    // The three client messages, each WITHOUT a request (§UC-GP-007 item 9 mirrors 003).
    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('edit-error')).toHaveText(GP3_MSG_POINT)
    await page.getByTestId('guest-packeta-address').fill(`  ${POINT}  `)
    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('edit-error')).toHaveText(GP3_MSG_EMAIL)
    await input.fill('nie-je-email')
    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('edit-error')).toHaveText(GP3_MSG_SHAPE)
    expect(writes, 'no request for a client-side refusal').toEqual([])

    const email = gp4Email()
    await input.fill(`  ${email}  `)
    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('status-packeta-address')).toHaveText(POINT)
    expect(writes).toEqual([{
      items: [{ product_id: s.product.id, variant: '250g', quantity: 1 }],
      use_parcel_delivery: true, packeta_address: POINT, guest_email: email,
    }])
    await expect(page.getByTestId('status-total')).toHaveText('28.40 EUR')
    await expect(page.locator('.card', { has: page.getByTestId('status-packeta-address') }).locator('.sub'))
      .toHaveText(GP4_POINT_SUB(email))
    expect(guestRow(o.order.id)).toMatchObject({ guest_email: email, delivery_fee: 3.5, packeta_address: POINT })

    // Re-entering edit: the order now HAS an e-mail, so the input never shows again.
    await page.getByTestId('start-edit').click()
    await expect(page.getByTestId('guest-delivery-packeta')).toBeChecked()
    await expect(page.getByTestId('edit-guest-email')).toHaveCount(0)
  })

  test('a via_host order WITH an e-mail switching to Packeta: no e-mail input and no `guest_email` key in the save', async ({ page }) => {
    const s = await scenario('gp4hasmail', { fee: 3.5 })
    const o = await submitOk(s.link.token, viaHostBody(s.items, { guest_email: gp4Email() }))
    const writes = gp4Writes(page, o.order.order_token)

    await gp4Status(page, o)
    await page.getByTestId('start-edit').click()
    await gp4EditRow(page, 'guest-delivery-packeta').click()
    await expect(page.getByTestId('guest-packeta-address'), 'non-vacuity: the Packeta branch is open').toBeVisible()
    await expect(page.getByTestId('edit-guest-email')).toHaveCount(0)
    await page.getByTestId('guest-packeta-address').fill(POINT)
    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('status-packeta-address')).toHaveText(POINT)
    expect(writes.map((w) => Object.keys(w).sort())).toEqual([['items', 'packeta_address', 'use_parcel_delivery']])
  })

  test('parcels switched OFF after the guest chose Packeta: no card, the warn banner, and the save sends `false`', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const s = await scenario('gp4gone', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    expect((await setCycle(s.cycle.id, { parcel_enabled: false })).status()).toBe(200)
    const first = s.host.name.split(' ')[0]
    const writes = gp4Writes(page, o.order.order_token)

    await gp4Status(page, o)
    // The read view still tells the truth about the STORED state (rule 5).
    await expect(page.getByTestId('status-packeta-address')).toHaveText(POINT)
    await page.getByTestId('start-edit').click()
    await expect(page.getByTestId(`product-${s.product.id}`), 'non-vacuity: edit mode rendered').toBeVisible()
    await expect(page.getByTestId('edit-delivery-card')).toHaveCount(0)
    await expect(page.getByTestId('guest-delivery-choice')).toHaveCount(0)
    const banner = page.getByTestId('edit-parcel-unavailable')
    await expect(banner).toHaveText(GP4_PARCEL_GONE(first))
    await expect(banner).toHaveClass(/\bbanner\b.*\bwarn\b.*\bslim\b|\bbanner\b.*\bslim\b.*\bwarn\b/)
    await expect(page.getByTestId('edit-total'), 'no fee offered on a parcel-off round').toHaveText('Celkom: 24.90 EUR')

    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('status-packeta-address')).toHaveCount(0)
    expect(writes).toEqual([{ items: [{ product_id: s.product.id, variant: '250g', quantity: 1 }], use_parcel_delivery: false }])
    expect(guestRow(o.order.id)).toMatchObject({ delivery_fee: 0, packeta_address: null })
  })

  test('a parcel-OFF via_host order: no card, no banner — and cancel from edit mode still sends the literal `{ items: [] }` only', async ({ page }) => {
    const s = await scenario('gp4plain', { parcel: false })
    const o = await submitOk(s.link.token, viaHostBody(s.items))
    const writes = gp4Writes(page, o.order.order_token)

    await gp4Status(page, o)
    await page.getByTestId('start-edit').click()
    await expect(page.getByTestId(`product-${s.product.id}`), 'non-vacuity: edit mode rendered').toBeVisible()
    await expect(page.getByTestId('edit-delivery-card')).toHaveCount(0)
    await expect(page.getByTestId('edit-parcel-unavailable')).toHaveCount(0)
    await page.getByTestId('cancel-order').click()
    await page.getByTestId('confirm-cancel-order').click()
    await expect(page.getByTestId('status-cancelled')).toBeVisible()
    expect(writes, 'the cancel payload is untouched by the delivery block').toEqual([{ items: [] }])
  })

  test('cancel from edit mode on a PACKETA order is still exactly `{ items: [] }`', async ({ page }) => {
    const s = await scenario('gp4pcanc', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items))
    const writes = gp4Writes(page, o.order.order_token)

    await gp4Status(page, o)
    await page.getByTestId('start-edit').click()
    await expect(page.getByTestId('edit-delivery-card')).toBeVisible()
    await page.getByTestId('cancel-order').click()
    await page.getByTestId('confirm-cancel-order').click()
    await expect(page.getByTestId('status-cancelled')).toBeVisible()
    expect(writes).toEqual([{ items: [] }])
  })

  test('the rendered copy sweep: Packeta read view + edit branch carry no „cyklus"/„kolo"', async ({ page }) => {
    const s = await scenario('gp4vocab', { fee: 3.5 })
    const o = await submitOk(s.link.token, viaHostBody(s.items))
    await gp4Status(page, o)
    await page.getByTestId('start-edit').click()
    await gp4EditRow(page, 'guest-delivery-packeta').click()
    let copy = await page.evaluate(collectAppCopy())
    expect(copy.toLowerCase(), 'non-vacuity: the e-mail branch rendered').toContain('packeta vám naň pošle')
    expect(BANNED.test(copy), copy).toBe(false)

    await page.getByTestId('guest-packeta-address').fill(POINT)
    await page.getByTestId('edit-guest-email').fill(gp4Email())
    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('status-packeta')).toBeVisible()
    copy = await page.evaluate(collectAppCopy())
    expect(copy.toLowerCase(), 'non-vacuity: the Packeta read view rendered').toContain('doručí packeta')
    expect(BANNED.test(copy), copy).toBe(false)
    for (const str of [GP4_SUB_PACKETA('X'), GP4_PILL, GP4_POINT_SUB('x'), GP4_PARCEL_GONE('X'), GP4_EDIT_FEE('1 EUR'),
      GP4_HOST_NOTE, GP4_BREAKDOWN('1 EUR', '1 EUR')]) {
      expect(str, 'no „cyklus"/„kolo" in the new copy').not.toMatch(BANNED)
    }
  })

  test('keyboard: the choice card is a real Tab stop, and Tab continues from the point field into the write-once e-mail input', async ({ page }) => {
    const s = await scenario('gp4kbd', { fee: 3.5 })
    const o = await submitOk(s.link.token, viaHostBody(s.items))
    expect(guestRow(o.order.id).guest_email, 'non-vacuity: the e-mail branch is reachable').toBeNull()

    await gp4Status(page, o)
    await page.getByTestId('start-edit').click()
    const viaHostRadio = page.getByTestId('guest-delivery-via-host')
    const packetaRadio = page.getByTestId('guest-delivery-packeta')
    await viaHostRadio.focus()
    await expect(viaHostRadio, 'the choice card mounted in edit mode is reachable, same as the checkout (GP-T3)').toBeFocused()

    await page.keyboard.press('ArrowDown')
    await expect(packetaRadio, 'the native group still moves with arrow keys here').toBeChecked()
    const point = page.getByTestId('guest-packeta-address')
    await expect(point).toBeVisible()

    await page.keyboard.press('Tab')
    await expect(point, 'one Tab stop for the group, then the point field').toBeFocused()
    await page.keyboard.type(POINT)

    // The e-mail input is EDIT MODE's own addition (§UC-GP-007 item 7) — no equivalent
    // exists in the checkout, so its place in the Tab order is this test's to prove.
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('edit-guest-email'), 'Tab continues past the point field into the write-once e-mail input').toBeFocused()
  })
})

// ─── §UC-GP-008 — the host card ──────────────────────────────────────────────

// The colleagues-panel idiom: a real per-friend Bearer session restored from
// localStorage (a RESTORE is not a login — neither the explainer nor the profile
// modal opens), and the admin-only friends list the portal asks for stubbed.
async function gp4SignInAsHost(page, host) {
  await page.addInitScript((value) => {
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({ friendId: host.id, friendName: host.name, token: host.token, expiresAt: Date.now() + 864e5 }))
  await page.route('**/api/friends?active=true', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{ id: host.id, name: host.name, uid: 'E2EGP4', active: 1, subscriptions: ['coffee', 'bakery'] }]),
  }))
}

async function gp4OpenPanel(page, s) {
  await page.setViewportSize(GP3_PHONE)
  await gp4SignInAsHost(page, s.host)
  await portalGotoCycle(page, s.cycle.id)
  await page.getByTestId('main-tab-guests').click()
  const panel = page.getByTestId('guest-sub-orders')
  await expect(panel).toBeVisible()
  return panel
}

const gp4Card = (panel, id) => panel.locator('.suborder', { has: panel.page().getByTestId(`guest-copy-url-${id}`) })

test.describe('GP-T4 · 20 §UC-GP-008 — the host card', () => {
  test('LOCKED, one Packeta + one via_host: badge outside `sub-order-badges`, point, sentence, no tick, fee-inclusive foot; the tab badge reads 1', async ({ page }) => {
    const s = await scenario('gp4hostv', { fee: 3.5 })
    const p = await submitOk(s.link.token, packetaBody(s.items))
    const v = await submitOk(s.link.token, viaHostBody(s.items))
    expect((await setCycle(s.cycle.id, { status: 'locked' })).status()).toBe(200)

    // ⚠ The host `totals` stay PRODUCT-ONLY (GSO-T5 pin) — the context line is not a charge.
    const view = await (await ctx.get(`/api/guest-links/cycle/${s.cycle.id}`, { headers: s.host.auth })).json()
    expect(view.totals).toEqual({ count: 2, total: 49.8 })

    const panel = await gp4OpenPanel(page, s)
    // count = 2, pendingDelivery = 1 (the Packeta bag owes the host nothing) ⇒ amber 1.
    await expect(page.getByTestId('guest-tab-badge'), 'pendingDelivery excludes the Packeta row').toHaveText('1')
    await expect(panel.locator('.sub').first(), 'heading money line = product-only totals')
      .toContainText('spolu 49.80 EUR')

    const pc = gp4Card(panel, p.order.id)
    const badge = pc.getByTestId(`guest-packeta-${p.order.id}`)
    await expect(badge).toHaveText('Packeta')
    await expect(badge).toHaveClass(/\bbadge\b/)
    await expect(badge).toHaveClass(/\bdanger\b/)
    await expect(pc.getByTestId('sub-order-badges').getByTestId(`guest-packeta-${p.order.id}`), 'NOT inside sub-order-badges').toHaveCount(0)
    await expect(pc.getByTestId('sub-order-badges').locator('.badge'), 'still exactly one status badge').toHaveCount(1)
    // …and inside the name block, so the fold control is the same control.
    await expect(pc.getByTestId(`guest-items-toggle-${p.order.id}`).getByTestId(`guest-packeta-${p.order.id}`)).toHaveCount(1)
    const addr = pc.getByTestId(`guest-packeta-address-${p.order.id}`)
    await expect(addr).toHaveText(POINT)
    await expect(addr).toHaveAttribute('data-user-copy', '')
    await expect(pc.getByTestId(`guest-packeta-note-${p.order.id}`)).toHaveText(GP4_HOST_NOTE)
    await expect(pc.getByTestId(`guest-delivered-${p.order.id}`), 'nothing to hand over').toHaveCount(0)
    await expect(pc.getByTestId(`guest-copy-url-${p.order.id}`), 'the resend stays').toBeVisible()
    await expect(pc.locator('.foot .total')).toHaveText('28.40 EUR')
    await expect(pc.getByTestId(`guest-total-breakdown-${p.order.id}`)).toHaveText(GP4_BREAKDOWN('24.90 EUR', '3.50 EUR'))

    const vc = gp4Card(panel, v.order.id)
    await expect(vc.getByTestId(`guest-delivered-${v.order.id}`), 'non-vacuity: the via_host row keeps its tick').toBeVisible()
    await expect(vc.getByTestId(`guest-packeta-${v.order.id}`)).toHaveCount(0)
    await expect(vc.getByText(GP4_HOST_NOTE)).toHaveCount(0)
    await expect(vc.locator('.foot .total')).toHaveText('24.90 EUR')
    await expect(vc.getByTestId(`guest-total-breakdown-${v.order.id}`)).toHaveCount(0)

    // Tick the only hand-over there is ⇒ pendingDelivery 0 ⇒ the badge falls back to count.
    await vc.getByTestId(`guest-delivered-${v.order.id}`).click()
    await expect(vc.getByTestId(`guest-delivered-${v.order.id}`)).toBeChecked()
    await expect(page.getByTestId('guest-tab-badge')).toHaveText('2')
  })

  test('OPEN round: „Odstrániť" stays on a Packeta row; a CANCELLED Packeta row keeps the badge + point and strikes the ITEMS amount', async ({ page }) => {
    const s = await scenario('gp4hostc', { fee: 3.5 })
    const live = await submitOk(s.link.token, packetaBody(s.items))
    const gone = await submitOk(s.link.token, packetaBody(s.items))
    expect((await editCanonical(gone)({ items: [] })).status()).toBe(200)

    const panel = await gp4OpenPanel(page, s)
    const lc = gp4Card(panel, live.order.id)
    await expect(lc.getByTestId(`guest-remove-${live.order.id}`), 'soft cancel stays on a Packeta row').toBeVisible()
    await expect(lc.getByTestId(`guest-delivered-${live.order.id}`)).toHaveCount(0)

    const cc = gp4Card(panel, gone.order.id)
    await expect(cc.getByTestId(`guest-status-${gone.order.id}`), 'non-vacuity: the cancelled row').toHaveText('Zrušené')
    await expect(cc.getByTestId(`guest-packeta-${gone.order.id}`), 'the record keeps its badge').toHaveText('Packeta')
    await expect(cc.getByTestId(`guest-packeta-address-${gone.order.id}`)).toHaveText(POINT)
    await expect(cc.getByTestId(`guest-packeta-note-${gone.order.id}`), 'no live promise on a called-off bag').toHaveCount(0)
    await expect(cc.locator('.foot .sub').first(), 'cancelledTotal() = items, the fee is not recomputed').toHaveText('24.90 EUR')
    await expect(cc.getByTestId(`guest-total-breakdown-${gone.order.id}`)).toHaveCount(0)
  })

  test('the rendered copy sweep: the host card\'s Packeta badge, point and sentence carry no „cyklus"/„kolo"', async ({ page }) => {
    const s = await scenario('gp4hostvocab', { fee: 3.5 })
    await submitOk(s.link.token, packetaBody(s.items))
    const panel = await gp4OpenPanel(page, s)
    await expect(panel.getByText(GP4_HOST_NOTE), 'non-vacuity: the sentence really rendered').toBeVisible()
    const copy = await page.evaluate(collectAppCopy())
    // ⚠ CLAUDE.md's `innerText` trap: it applies `text-transform`, and the badge
    // renders UPPERCASE (`PACKETA`) — case-insensitive, same as the other sweeps here.
    expect(copy.toLowerCase(), 'non-vacuity: the Packeta badge really rendered').toContain('packeta')
    expect(copy.toLowerCase(), 'non-vacuity: the host sentence really rendered').toContain('nemusíte nič odovzdávať')
    expect(BANNED.test(copy), copy).toBe(false)
  })
})

test.describe('GP-T4 · 320px — the new blocks overflow nothing', () => {
  // The document AND every descendant scroller (CLAUDE.md: a scroller absorbs the
  // spill, so measuring the document alone proves nothing).
  const overflow = (page) => page.evaluate(() => {
    const out = []
    const de = document.documentElement
    if (de.scrollWidth > de.clientWidth) out.push(`document ${de.scrollWidth} > ${de.clientWidth}`)
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (!/(auto|scroll)/.test(cs.overflowX)) continue
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName}.${el.className} ${el.scrollWidth} > ${el.clientWidth}`)
    }
    return out
  })
  const LONG = 'Z-BOX Obchodné centrum Hlavná stanica Bratislava-Staré Mesto Námestie Slobody 1234567890'

  test('status page: the Packeta read view and the edit card with the e-mail input at 320px', async ({ page }) => {
    const s = await scenario('gp4narrow', { fee: 3.5 })
    const o = await submitOk(s.link.token, packetaBody(s.items, { packeta_address: LONG }))
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto(`/g/o/${o.order.order_token}`)
    await expect(page.getByTestId('status-packeta-address'), 'non-vacuity').toHaveText(LONG)
    expect(await overflow(page)).toEqual([])
    const v = await submitOk(s.link.token, viaHostBody(s.items))
    await page.goto(`/g/o/${v.order.order_token}`)
    await page.getByTestId('start-edit').click()
    await gp4EditRow(page, 'guest-delivery-packeta').click()
    await page.getByTestId('guest-packeta-address').fill(LONG)
    await expect(page.getByTestId('edit-guest-email'), 'non-vacuity: the widest branch').toBeVisible()
    await expect(page.getByTestId('edit-delivery-fee')).toBeVisible()
    expect(await overflow(page)).toEqual([])
  })

  test('host card: a Packeta row with a long point at 320px', async ({ page }) => {
    const s = await scenario('gp4narrowh', { fee: 3.5 })
    const p = await submitOk(s.link.token, packetaBody(s.items, { packeta_address: LONG }))
    await page.setViewportSize({ width: 320, height: 900 })
    await gp4SignInAsHost(page, s.host)
    await portalGotoCycle(page, s.cycle.id)
    await page.getByTestId('main-tab-guests').click()
    await expect(page.getByTestId(`guest-packeta-address-${p.order.id}`), 'non-vacuity').toHaveText(LONG)
    await expect(page.getByTestId(`guest-total-breakdown-${p.order.id}`)).toBeVisible()
    expect(await overflow(page)).toEqual([])
  })
})

test.describe('GP-T4 · source pins — one home, and what this row must NOT touch', () => {
  test('GuestOrderStatus.vue mounts GuestDeliveryChoice ONCE, imports the ONE EMAIL_SHAPE, and holds no copy of the choice', () => {
    test.skip(!HAS_SRC, NEEDS_SRC)
    const view = assertReadable('views/GuestOrderStatus.vue', ['edit-error', 'GuestDeliveryChoice', 'status-total'])
    expect(view.match(/<GuestDeliveryChoice\b/g) || [], 'one mount').toHaveLength(1)
    expect(view).toMatch(/import GuestDeliveryChoice from '@\/components\/GuestDeliveryChoice\.vue'/)
    expect(view).toMatch(/import \{ EMAIL_SHAPE \} from '@\/lib\/email-shape'/)
    for (const token of ['guest-packeta-address', 'Poslať Packetou', 'Prevezmem od', 'type="radio"']) {
      expect(view, `„${token}" lives in the component, never in the view`).not.toContain(token)
    }
    // The fee line is a CartLineList EXTRA through lib/order-lines.js — never new markup.
    expect(view).toMatch(/import \{ deliveryExtras \} from '@\/lib\/order-lines'/)
    // The total is the SERVER's amount (§UC-GP-004: no surface composes it from the cart).
    expect(view).toMatch(/data-testid="status-total">\{\{ fmtEur\(amountDue\) \}\}</)
    // Shipped, load-bearing behaviour untouched (§UC-GP-007 item 10).
    expect(view).toContain('watch(orderToken, () => {')
    expect(view).toContain('let loadSeq = 0')
    expect(view).toMatch(/document\.title = cycle\.value\?\.name/)
    expect(view, 'the cancel payload is the literal empty cart').toMatch(/submitEdit\(\{ items: \[\] \}\)/)
  })

  test('GuestSubOrders.vue: the tick is gated on the Packeta marker, pendingDelivery excludes it, and `totals` is never folded with the fee', () => {
    test.skip(!HAS_SRC, NEEDS_SRC)
    const comp = assertReadable('components/GuestSubOrders.vue', ['guest-delivered-', 'pendingDelivery', 'sub-order-badges'])
    expect(comp).toMatch(/pendingDelivery: live\.reduce\(\(sum, o\) => sum \+ \(o\.delivered \|\| isPacketa\(o\) \? 0 : 1\), 0\)/)
    expect(comp).toMatch(/function isPacketa\(subOrder\) \{\s*return !!subOrder\.packeta_address\s*\}/)
    // The marker is the ADDRESS, never the fee (learnings 12 §1).
    expect(comp, 'no fee-based Packeta test').not.toMatch(/delivery_fee\s*>\s*0\s*\?|isPacketa[^\n]*delivery_fee/)
    // `totals` stays the server's product-only figure.
    expect(comp, 'the heading reads totals.total untouched').toContain('formatPrice(totals.total)')
    expect(comp, 'no fee folded into totals').not.toMatch(/totals\.value\.total\s*\+|totals\.total\s*\+/)
    // The sub-order-badges block holds no Packeta badge.
    const block = comp.slice(comp.indexOf('data-testid="sub-order-badges"'), comp.indexOf('</div>', comp.indexOf('data-testid="sub-order-badges"')))
    expect(block, 'readability gate').toContain('guest-paid-badge')
    expect(block).not.toContain('packeta')
  })
})
