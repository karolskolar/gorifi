import { test, expect, request as playwrightRequest } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'

// Module 15 — payment links. Started by PL-T1, grown by PL-T2, and still to be grown by
// PL-T3/T4 (the client link composition and the friend surfaces).
//
// What it pins TODAY, in file order:
//   1. §UC-PL-001 — the derivation rules of `backend/src/helpers/payment.js`: the three
//      VS schemes, the range guard that makes them provably disjoint, the two composers
//      (`guestPaymentBlock()`, `balancePaymentBlock()`) and the one-home source sweeps.
//   2. §UC-PL-002 — the `payment_creditor_name` setting, API and AdminSettings UI.
//   3. §UC-PL-003 (PL-T2) — every payload a payer is handed: the guest 201 and both
//      status URL forms, the friend order GET/PUT/submit, the balance, the admin unpaid
//      overview and the admin orders tab.
//   4. §UC-PL-008 (PL-T2) — „VS …" on the admin's receivables card and orders tab, plus
//      the admin-invariance gate on `CycleDetail.vue`.
// The guest confirmation mail's VS row (§UC-PL-003 item 2) is pinned where the mail
// harness already lives: `guest-order-recovery.spec.js`'s UC-GR-011 describe.
//
// ⚠ WHY THE VS RULES ARE ALSO TESTED THROUGH A CHILD PROCESS AND NOT ONLY THROUGH THE
// PAYLOADS. The rule that matters most — a friend id and a guest id must NEVER map onto
// the same number — is invisible from any single payload: it is a statement about three
// functions at once, over ids no fixture can conjure (1,000,000; a float; `NaN`). So the
// helper is ALSO imported in a throwaway `node` process against a throwaway DB file — the
// `google-auth-verifier.spec.js` / `catalog-foundation.spec.js` idiom — and every
// derivation is read off the real module, not re-implemented here. The payload tests in
// section 3 are the other half: they prove the routes actually call it.
//
// ⚠ THE GATE IS THE BACKEND SOURCE, NOT `payment.js` ITSELF. "The helper is missing"
// must be a RED run, not a silent skip (the vacuity trap the `DB_PATH` self-skips have).
//
// ⚠ Ordering inside the file: the first API block reads the SEEDED creditor name before
// anything mutates it, and every UI block runs after the API ones because a UI admin login
// invalidates the single app-wide admin session (the `admin-friends-labels.spec.js` note),
// so an API context's token goes dead under it. `pl2Fixtures()` re-logs-in for exactly that
// reason, and so does the file's `afterAll` restore.

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND_ENTRY = path.resolve(E2E_DIR, '../backend/src/index.js')
const HELPER_ENTRY = path.resolve(E2E_DIR, '../backend/src/helpers/payment.js')
const BACKEND_SRC = path.resolve(E2E_DIR, '../backend/src')
const CYCLE_DETAIL_VIEW = path.resolve(E2E_DIR, '../frontend/src/views/CycleDetail.vue')
const CAN_IMPORT_HELPER = fs.existsSync(BACKEND_ENTRY)
const NEEDS_SOURCE = 'needs the backend source beside e2e/ (skipped against a deployment)'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'

// §UC-PL-002 literals. Exact strings: the refusal is user-visible admin copy.
const MAX_CREDITOR_NAME = 70
const CREDITOR_TOO_LONG = 'Meno príjemcu môže mať najviac 70 znakov'
const CREDITOR_LABEL = 'Meno príjemcu'

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// ── The VS cases, as SOURCE TEXT ─────────────────────────────────────────────
// Passed to the child verbatim and `eval`ed there, so the case list has ONE home
// and values JSON cannot carry (`undefined`, `NaN`, `Infinity`) are still covered.
// The label IS the source, so a failure names the input that produced it.
const VALID_IDS = ['1', '17', '123', '45', '999999']
const REFUSED_IDS = [
  '0', '-1', '1.5', '1000000', '8000000', '9000017', '1e7',
  "'17'", 'null', 'undefined', 'NaN', 'Infinity', '-Infinity', '({})', '[17]', 'true',
]
const VS_CASES = [...VALID_IDS, ...REFUSED_IDS]

// Every derivation the child performs, keyed by the source text above.
let vs = null
// `guestPaymentBlock()` / `paymentSettings()` against an EMPTY throwaway database.
let helperProbe = null

async function runHelper() {
  const script = [
    "const mod = await import(process.env.PAYMENT_HELPER_URL)",
    "const cases = JSON.parse(process.env.PAYMENT_CASES)",
    "const vs = {}",
    "for (const src of cases) {",
    "  const value = (0, eval)(src)",
    "  vs[src] = {",
    "    friend: mod.friendOrderVariableSymbol(value),",
    "    guest: mod.guestOrderVariableSymbol(value),",
    "    balance: mod.balanceVariableSymbol(value),",
    "  }",
    "}",
    // The no-argument call: `undefined` reached WITHOUT passing it, which is what a
    // `payment: null` branch or a missing row actually does.
    "vs['<no argument>'] = {",
    "  friend: mod.friendOrderVariableSymbol(),",
    "  guest: mod.guestOrderVariableSymbol(),",
    "  balance: mod.balanceVariableSymbol(),",
    "}",
    "const settings = mod.paymentSettings()",
    "const block = mod.guestPaymentBlock({ id: 5, total: 12.5, guest_name: 'Jana Hostka' }, 'Cyklus 7')",
    "const balanceBlocks = {",
    "  debt: mod.balancePaymentBlock({ id: 7, name: 'Karol Skolar', balance: -26.19 }),",
    "  settled: mod.balancePaymentBlock({ id: 7, name: 'Karol Skolar', balance: 0 }),",
    "  credit: mod.balancePaymentBlock({ id: 7, name: 'Karol Skolar', balance: 4.5 }),",
    "  drift: mod.balancePaymentBlock({ id: 7, name: 'Karol Skolar', balance: -26.189999999999998 }),",
    "}",
    "const maxCreditorNameLength = mod.MAX_CREDITOR_NAME_LENGTH",
    "process.stdout.write('\\nPAYMENT_RESULT:' + JSON.stringify({ vs, settings, block, balanceBlocks, maxCreditorNameLength }) + '\\n')",
  ].join('\n')

  // ⚠ A throwaway DB PATH, never the gate server's file: importing the helper boots
  // `db/schema.js`, which OPENS (and migrates) whatever `DB_PATH` names. A fresh name
  // per run is the README's own rule, applied to the child.
  const dbPath = path.join(os.tmpdir(), `gorifi-payment-helper-${uniq}.sqlite`)
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      DB_PATH: dbPath,
      PAYMENT_HELPER_URL: pathToFileURL(HELPER_ENTRY).href,
      PAYMENT_CASES: JSON.stringify(VS_CASES),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', (c) => { output += c })
  child.stderr.on('data', (c) => { output += c })
  const exitCode = await new Promise((resolve) => child.on('exit', resolve))

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix, { force: true }) } catch { /* best effort */ }
  }

  const match = output.match(/PAYMENT_RESULT:(.*)/)
  if (exitCode !== 0 || !match) {
    throw new Error(`helpers/payment.js could not be driven (exit ${exitCode}):\n${output}`)
  }
  return JSON.parse(match[1])
}

// ── API context ──────────────────────────────────────────────────────────────
let ctx = null
let adminToken = ''
let seededCreditorName = null
let seededIban = null

const admin = () => ({ 'X-Admin-Token': adminToken })

async function loginApi() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login for the settings fixtures').toBe(200)
  adminToken = (await login.json()).token
}

/** The ADMIN settings row, read back rather than trusted from the mutation response. */
async function adminSettings() {
  const res = await ctx.get('/api/admin/settings', { headers: admin() })
  expect(res.status(), 'admin settings readable').toBe(200)
  return res.json()
}

/** The PUBLIC payment settings — deliberately unauthenticated (§UC-PL-002). */
async function publicPaymentSettings(headers = undefined) {
  const res = await ctx.get('/api/admin/payment-settings', headers ? { headers } : undefined)
  return res
}

async function putSettings(data) {
  return ctx.put('/api/admin/settings', { headers: admin(), data })
}

async function setCreditorName(value) {
  const res = await putSettings({ paymentCreditorName: value })
  expect(res.status(), `creditor name set to ${JSON.stringify(value)}`).toBe(200)
  return res
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  await loginApi()

  // ⚠ Read the SEEDED values BEFORE any test mutates them — `seed.mjs` 3b is what makes
  // the PayMe path non-vacuous, and a test that ran first would hide a seed that never
  // set it.
  const seeded = await publicPaymentSettings()
  expect(seeded.status(), 'public payment settings reachable').toBe(200)
  const body = await seeded.json()
  seededCreditorName = body.paymentCreditorName
  seededIban = body.paymentIban

  if (CAN_IMPORT_HELPER) {
    const probe = await runHelper()
    vs = probe.vs
    helperProbe = probe
  }
})

test.afterAll(async () => {
  if (!ctx) return
  // The UI block below mints a new admin session, so the token from `beforeAll` may be
  // dead by now. Re-login, then put the instance back exactly as it was found.
  try {
    await loginApi()
    await putSettings({ paymentCreditorName: seededCreditorName ?? '' })
  } catch { /* the restore is best-effort; the per-run DB copy is the real isolation */ }
  await ctx.dispose()
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. §UC-PL-001 — the variable-symbol scheme
// ═══════════════════════════════════════════════════════════════════════════

test.describe('PL-T1 §UC-PL-001 — the one home for a variable symbol', () => {
  test.skip(!CAN_IMPORT_HELPER, NEEDS_SOURCE)

  test('a friend order VS is the bare order id', () => {
    expect(vs['1'].friend).toBe('1')
    expect(vs['17'].friend).toBe('17')
    expect(vs['999999'].friend).toBe('999999')
  })

  test('a guest sub-order VS is `9` + the id padded to six digits', () => {
    expect(vs['1'].guest).toBe('9000001')
    expect(vs['17'].guest).toBe('9000017')
    expect(vs['123'].guest).toBe('9000123')
    expect(vs['999999'].guest).toBe('9999999')
  })

  test('a balance VS is `8` + the friend id padded to six digits', () => {
    expect(vs['1'].balance).toBe('8000001')
    expect(vs['45'].balance).toBe('8000045')
    expect(vs['999999'].balance).toBe('8999999')
  })

  test('every emitted VS is numeric and at most 10 digits (Pay by Square / PayMe)', () => {
    for (const id of VALID_IDS) {
      for (const kind of ['friend', 'guest', 'balance']) {
        expect(vs[id][kind], `${kind} VS of ${id}`).toMatch(/^\d{1,10}$/)
      }
    }
  })

  // ⚠ THE POINT OF THE PREFIXES. Friend order 17, guest sub-order 17 and friend 17's
  // balance are three DIFFERENT debts that share one bare number. If any two of them
  // ever produced the same VS, a bank statement would match money to the wrong person —
  // which is strictly worse than no VS at all.
  test('the three schemes are pairwise disjoint — a shared id never yields a shared VS', () => {
    for (const id of VALID_IDS) {
      const { friend, guest, balance } = vs[id]
      expect(new Set([friend, guest, balance]).size, `three distinct VS for id ${id}`).toBe(3)
    }

    const emitted = new Map()
    for (const id of VALID_IDS) {
      for (const kind of ['friend', 'guest', 'balance']) {
        const value = vs[id][kind]
        const owner = `${kind}:${id}`
        expect(emitted.has(value), `${value} already emitted for ${emitted.get(value)}, now ${owner}`).toBe(false)
        emitted.set(value, owner)
      }
    }
  })

  // The other half of the same rule: the ONLY way a friend VS could collide with a
  // guest/balance one is an order id of 8,000,000+ (it would then start with 8 or 9 and
  // be 7 digits long). The range guard refuses exactly there, so the collision is
  // unreachable rather than merely unlikely.
  test('an id large enough to collide with a prefixed scheme is refused, not emitted', () => {
    for (const id of ['1000000', '8000000', '9000017', '1e7']) {
      expect(vs[id].friend, `friend VS of ${id}`).toBe('')
      expect(vs[id].guest, `guest VS of ${id}`).toBe('')
      expect(vs[id].balance, `balance VS of ${id}`).toBe('')
    }
    // And the number that WOULD have collided is the guest VS of a legal id, proving
    // the case above is not vacuous.
    expect(vs['17'].guest).toBe('9000017')
  })

  test('anything that is not a positive integer id fails closed with an empty VS', () => {
    const refused = [...REFUSED_IDS, '<no argument>']
    for (const id of refused) {
      for (const kind of ['friend', 'guest', 'balance']) {
        expect(vs[id][kind], `${kind} VS of ${id}`).toBe('')
      }
    }
  })

  test('paymentSettings() answers an empty string for every absent key', () => {
    expect(helperProbe.settings).toEqual({ iban: '', revolut_username: '', creditor_name: '' })
  })

  // ⚠ MODULE-20 SEAM. `amount` is `order.total` TODAY. GP-T1 changes that ONE line in
  // `helpers/payment.js` to `total + delivery_fee` and this expectation moves with it.
  test('guestPaymentBlock() composes the one guest payment block', () => {
    expect(helperProbe.block).toEqual({
      amount: 12.5,
      reference: 'G5 / Jana Hostka / Cyklus 7',
      variable_symbol: '9000005',
      iban: '',
      revolut_username: '',
      creditor_name: '',
    })
  })

  // ⚠ The SIGN FLIP and the rounding live in the helper, so no screen can quote one debt
  // with the other sign — and `26.189999999999998` (a real incident: a banking app refused
  // the QR) leaves as `26.19`. The route only passes the row it already has.
  test('balancePaymentBlock() asks for what is OWED, rounded, and nothing when settled', () => {
    expect(helperProbe.balanceBlocks.debt).toEqual({
      amount: 26.19,
      reference: 'Karol Skolar / zostatok',
      variable_symbol: '8000007',
      iban: '',
      revolut_username: '',
      creditor_name: '',
    })
    expect(helperProbe.balanceBlocks.settled.amount, 'settled owes nothing').toBe(0)
    expect(helperProbe.balanceBlocks.credit.amount, 'in credit owes nothing either').toBe(0)
    expect(helperProbe.balanceBlocks.drift.amount, 'float drift never reaches a QR').toBe(26.19)
  })

  // The reviewer's check from §UC-PL-001, machine-checked: no route, view or template
  // concatenates its own VS.
  test('`padStart(6` exists in helpers/payment.js and NOWHERE ELSE under backend/src', () => {
    const files = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.js')) files.push(full)
      }
    }
    walk(BACKEND_SRC)
    // Non-vacuity: the sweep must have seen a real tree, and the one legal home must
    // actually contain the string it is the exception for.
    expect(files.length, 'the backend source tree was walked').toBeGreaterThan(20)
    expect(fs.readFileSync(HELPER_ENTRY, 'utf8')).toContain('padStart(6')

    const offenders = files
      .filter((f) => path.resolve(f) !== path.resolve(HELPER_ENTRY))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('padStart(6'))
      .map((f) => path.relative(BACKEND_SRC, f))
    expect(offenders, 'a second VS formatter').toEqual([])
  })

  // The OTHER half of what this row bought: four hand-written
  // `SELECT value FROM settings WHERE key = 'payment_…'` reads deleted in favour of one
  // `paymentSettings()`. The formatter sweep above would not notice a route quietly
  // re-inlining a read, so the KEY STRING is swept the same way — reader and writer both
  // take it from `helpers/payment.js`'s exported constants, so the literal has one home.
  // ⚠ Comments count as hits on purpose: a file that names the key is a file whose author
  // was thinking about reading it directly.
  test('the `payment_iban` key string lives in helpers/payment.js and NOWHERE ELSE under backend/src', () => {
    const files = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.js')) files.push(full)
      }
    }
    walk(BACKEND_SRC)
    expect(files.length, 'the backend source tree was walked').toBeGreaterThan(20)
    expect(fs.readFileSync(HELPER_ENTRY, 'utf8')).toContain("'payment_iban'")

    const offenders = files
      .filter((f) => path.resolve(f) !== path.resolve(HELPER_ENTRY))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('payment_iban'))
      .map((f) => path.relative(BACKEND_SRC, f))
    expect(offenders, 'a second reader/writer of the payment settings keys').toEqual([])
  })

  test('the 70-character bound has ONE home too (exported by the helper)', () => {
    expect(helperProbe.maxCreditorNameLength).toBe(MAX_CREDITOR_NAME)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. §UC-PL-002 — the `payment_creditor_name` setting (API)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('PL-T1 §UC-PL-002 — the payment_creditor_name setting', () => {
  test('seed.mjs 3b leaves a creditor name behind (the PayMe path is non-vacuous)', () => {
    expect(typeof seededCreditorName, 'the public payload carries the field').toBe('string')
    expect(seededCreditorName.length, 'seed 3b set a creditor name').toBeGreaterThan(0)
  })

  test('it round-trips through PUT and the admin GET', async () => {
    const name = `Karol Skolar ${uniq}`.slice(0, MAX_CREDITOR_NAME)
    const res = await setCreditorName(name)
    expect((await res.json()).paymentCreditorName, 'the PUT echoes it').toBe(name)
    expect((await adminSettings()).paymentCreditorName).toBe(name)
  })

  test('it is published on the PUBLIC payment-settings endpoint', async () => {
    const name = `Verejne Meno ${uniq}`.slice(0, MAX_CREDITOR_NAME)
    await setCreditorName(name)
    const res = await publicPaymentSettings()
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.paymentCreditorName).toBe(name)
    // Nothing the public endpoint already answered may be lost.
    expect(body).toHaveProperty('paymentIban')
    expect(body).toHaveProperty('paymentRevolutUsername')
  })

  // ⚠ DELIBERATE, AND SOMEONE WILL LATER "FIX" IT. `/api/admin/payment-settings` is the
  // one unguarded route under `/api/admin` (api-security.spec.js:150 lists it as public):
  // every friend and guest payment screen reads the IBAN from it while logged in as
  // nobody. The creditor name is public data by definition — a bank transfer shows it to
  // the payer — so publishing it here changes nothing about that boundary.
  test('the public endpoint stays public while the admin one stays guarded', async () => {
    const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      const pub = await anonymous.get('/api/admin/payment-settings')
      expect(pub.status(), 'anonymous read of the public payment settings').toBe(200)
      expect(await pub.json()).toHaveProperty('paymentCreditorName')

      const guarded = await anonymous.get('/api/admin/settings')
      expect(guarded.status(), 'the admin settings stay 401').toBe(401)

      // A wrong token is not a credential here either — it is simply ignored.
      const wrongToken = await anonymous.get('/api/admin/payment-settings', {
        headers: { 'X-Admin-Token': 'not-a-token' },
      })
      expect(wrongToken.status()).toBe(200)
    } finally {
      await anonymous.dispose()
    }
  })

  test('exactly 70 characters are accepted and read back', async () => {
    const name = 'K'.repeat(MAX_CREDITOR_NAME)
    const res = await setCreditorName(name)
    expect((await res.json()).paymentCreditorName).toHaveLength(MAX_CREDITOR_NAME)
    expect((await adminSettings()).paymentCreditorName).toBe(name)
  })

  test('71 characters are refused with a 400 and the stored value survives', async () => {
    const before = 'Meno pred odmietnutim'
    await setCreditorName(before)

    const res = await putSettings({ paymentCreditorName: 'K'.repeat(MAX_CREDITOR_NAME + 1) })
    expect(res.status(), 'one character over the bound').toBe(400)
    expect((await res.json()).error).toBe(CREDITOR_TOO_LONG)
    // ⚠ The refusal is asserted on the ROW, not on the status (the FUP-T13 lesson).
    expect((await adminSettings()).paymentCreditorName, 'unchanged after the refusal').toBe(before)
  })

  test('a refused creditor name writes NOTHING ELSE from the same request', async () => {
    const before = await adminSettings()
    const res = await putSettings({
      paymentIban: 'SK9911000000002611999999',
      paymentRevolutUsername: `pl1_${uniq}`,
      paymentCreditorName: 'K'.repeat(MAX_CREDITOR_NAME + 1),
    })
    expect(res.status()).toBe(400)
    const after = await adminSettings()
    expect(after.paymentIban, 'the IBAN in the refused request was not written').toBe(before.paymentIban)
    expect(after.paymentRevolutUsername).toBe(before.paymentRevolutUsername)
    expect(after.paymentCreditorName).toBe(before.paymentCreditorName)
    expect(after.friendsPassword, 'the shared password never moved').toBe(before.friendsPassword)
  })

  test('the value is trimmed — before the length check, not after it', async () => {
    await setCreditorName('   Karol   Skolar   ')
    expect((await adminSettings()).paymentCreditorName).toBe('Karol   Skolar')

    // 70 characters wrapped in whitespace is a LEGAL 70-character name.
    const padded = `    ${'M'.repeat(MAX_CREDITOR_NAME)}    `
    const res = await putSettings({ paymentCreditorName: padded })
    expect(res.status(), 'whitespace does not count against the bound').toBe(200)
    expect((await adminSettings()).paymentCreditorName).toBe('M'.repeat(MAX_CREDITOR_NAME))
  })

  test('an empty string clears it', async () => {
    await setCreditorName('Nieco')
    await setCreditorName('')
    expect((await adminSettings()).paymentCreditorName).toBe('')
    const pub = await publicPaymentSettings()
    expect((await pub.json()).paymentCreditorName).toBe('')
  })

  // ⚠ FUP-T13, applied to the new field. `[x]` is the trap: a one-element array SPREADS
  // into a single-slot statement, so before `bindValue` it was stored as the bare string
  // and answered a clean 200.
  test('unbindable body shapes are a no-op, never a 500 and never a blanked setting', async () => {
    const stored = `Stabilne meno ${uniq}`.slice(0, MAX_CREDITOR_NAME)
    await setCreditorName(stored)
    const before = await adminSettings()

    // ⚠ A finite NUMBER is deliberately absent from this list: `bindValue` binds one, so
    // `{ paymentCreditorName: 12 }` stores `12` exactly as `{ paymentIban: 12 }` always
    // has. "Exactly like the other two payment keys" (§UC-PL-002) means no new policy
    // here — a numeric-name rule would belong to all three or to none.
    for (const bad of [{}, true, false, ['Podvrh'], ['a', 'b'], { toString: 1 }, []]) {
      const res = await putSettings({ paymentCreditorName: bad })
      expect(res.status(), `shape ${JSON.stringify(bad)} must not 500`).not.toBe(500)
      const raw = JSON.stringify(await res.json())
      expect(raw, 'no internals leak').not.toMatch(/RangeError|TypeError|node_modules|at .*\.js/)
      expect(
        (await adminSettings()).paymentCreditorName,
        `shape ${JSON.stringify(bad)} left the stored name alone`,
      ).toBe(stored)
    }

    expect(await adminSettings(), 'no setting drifted').toEqual(before)
  })

  test('an absent field leaves the stored name untouched', async () => {
    const stored = `Neprepisat ${uniq}`.slice(0, MAX_CREDITOR_NAME)
    await setCreditorName(stored)
    const res = await putSettings({ paymentIban: seededIban ?? '' })
    expect(res.status()).toBe(200)
    expect((await adminSettings()).paymentCreditorName).toBe(stored)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. §UC-PL-002 — AdminSettings mirrors the server bound (UI, runs LAST)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('PL-T1 §UC-PL-002 — AdminSettings „Meno príjemcu“', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)
    await page.goto('/admin/settings')
  })

  test('the field is labelled, explained and capped at 70 characters', async ({ page }) => {
    const input = page.locator('#paymentCreditorName')
    await expect(input).toBeVisible()
    // CLAUDE.md: server length bounds are mirrored as `maxlength` in the UI.
    await expect(input).toHaveAttribute('maxlength', String(MAX_CREDITOR_NAME))
    await expect(page.locator('label[for="paymentCreditorName"]')).toHaveText(CREDITOR_LABEL)
    await expect(page.getByText('Meno majiteľa účtu')).toBeVisible()
  })

  test('it saves through the existing „Uložiť platobné údaje“ button and reloads', async ({ page }) => {
    const name = `Karol Skolar UI ${uniq}`.slice(0, MAX_CREDITOR_NAME)
    const input = page.locator('#paymentCreditorName')
    await input.fill(name)
    await page.getByRole('button', { name: /Uložiť platobné údaje/ }).click()
    await expect(page.getByText('Platobné údaje boli uložené')).toBeVisible()

    // Read back from the server, not from the control that was just typed into.
    const res = await page.request.get(`${BASE_URL}/api/admin/payment-settings`)
    expect(res.status()).toBe(200)
    expect((await res.json()).paymentCreditorName).toBe(name)

    await page.reload()
    await expect(page.locator('#paymentCreditorName')).toHaveValue(name)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. PL-T2 §UC-PL-003 — every payload a payer is handed carries the VS
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ THE ASSERTION THIS SECTION EXISTS FOR IS THE *NEGATIVE* ONE. PL-T2 replaces two
// hand-written guest `payment` blocks with one `guestPaymentBlock()` call, and a
// refactor is exactly where a silent change hides: an `amount` that started rounding,
// a `reference` that lost its `G` prefix, an `iban` that became `null` instead of `''`.
// So every block is asserted with a FULL `toEqual` object literal (a removed field and
// an unannounced added one both fail) plus an ordered `Object.keys` pin (the two guest
// surfaces must be the same function, key order included), and the four pre-existing
// fields are pinned to values this test itself chose: the amount from the ordered
// lines, the reference from the documented `G<id> / <name> / <cycle>` format, the IBAN
// and the Revolut handle from the settings written in `beforeAll`.
//
// ⚠ These describes run AFTER the UI block above, which mints a browser admin session
// and kills this context's token (ONE admin token app-wide). `pl2Fixtures()` therefore
// re-logs-in before it builds anything, and is memoised so the four describes below
// share one scenario.

const PL2_IBAN = 'SK3112000000198742637541'
const PL2_REVOLUT = `pl2handle${uniq}`.slice(0, 20)
const PL2_CREDITOR = `Podpultovka PL2 ${uniq}`.slice(0, MAX_CREDITOR_NAME)
const PL2_BALANCE_DEBT = -26.19

const guestVs = (id) => `9${String(id).padStart(6, '0')}`
const balanceVs = (friendId) => `8${String(friendId).padStart(6, '0')}`

let pl2Seq = 0
let pl2Promise = null

async function adminReq(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: admin(),
    ...(opts.data ? { data: opts.data } : {}),
  })
}

/** A friend with a real per-friend Bearer session (the guest-status.spec.js idiom). */
async function makeFriend(label) {
  const suffix = `_${uniq}${++pl2Seq}`
  const username = `pl2_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  expect(username.length, 'username must fit validateUsername').toBeLessThanOrEqual(30)
  const name = `Platca ${label} ${uniq}`
  const created = await adminReq('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()

  expect((await adminReq(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await adminReq(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const body = await login.json()
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || body.token
  return { id: friend.id, name, username, auth: { Authorization: `Bearer ${token}` } }
}

async function makePl2Cycle(label) {
  const name = `E2E PL2 ${label} ${uniq}`
  const res = await adminReq('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  // Markup pinned to 1 so the ordered lines ARE the money the payload must carry.
  expect((await adminReq(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: 1 } })).status()).toBe(200)
  return { ...cycle, name }
}

async function addPl2Product(cycleId, data) {
  const res = await adminReq('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function shareLinkFor(friend, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: friend.auth })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

async function submitGuest(linkToken, identity, items) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), `guest submit for ${identity.guest_name}`).toBe(201)
  return res.json()
}

/** ONE scenario for the whole of PL-T2: a host, a cycle, a friend order, three guests. */
function pl2Fixtures() {
  if (pl2Promise) return pl2Promise
  pl2Promise = (async () => {
    await loginApi()
    expect(
      (await putSettings({
        paymentIban: PL2_IBAN,
        paymentRevolutUsername: PL2_REVOLUT,
        paymentCreditorName: PL2_CREDITOR,
      })).status(),
      'the payment settings the payloads must echo',
    ).toBe(200)

    const host = await makeFriend('host')
    const bystander = await makeFriend('bezobj')
    // ⚠ A host who ordered NOTHING but whose colleague did: the ONLY placeholder row
    // (`id: null`) the orders tab actually renders — `listedOrders` drops a friend with
    // neither an order nor guest bags, so the `variable_symbol: null` case is only
    // visible on screen through this one.
    const ghostHost = await makeFriend('hostbezobj')
    // A saved cart that was never submitted: it HAS an `orders.id` (so the payload
    // carries a VS) while owing nothing — the row the tab renders as „-“ throughout.
    const draftFriend = await makeFriend('rozpracovany')
    const cycle = await makePl2Cycle('main')
    const product = await addPl2Product(cycle.id, {
      name: `PL2 kava ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30,
    })
    const link = await shareLinkFor(host, cycle.id)
    const ghostLink = await shareLinkFor(ghostHost, cycle.id)

    // The host's own submitted order — the friend-order payload and the admin row.
    const cart = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth,
      data: { items: [{ product_id: product.id, variant: '250g', quantity: 2 }] },
    })
    expect(cart.status(), 'the host fills a cart').toBe(200)
    const submitted = await ctx.post(`/api/orders/cycle/${cycle.id}/friend/${host.id}/submit`, {
      headers: host.auth, data: {},
    })
    expect(submitted.status(), 'the host submits').toBe(200)
    const friendOrder = (await submitted.json()).order

    // Guest 1 stays unpaid → the receivables card. Guest 2 is paid then cancelled by
    // the admin → the refund queue. Both carry a VS from the same helper.
    const unpaidGuest = await submitGuest(link.token, {
      guest_name: 'Jana Nezaplatena', guest_phone: '0902 333 444',
    }, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    const refundGuest = await submitGuest(link.token, {
      guest_name: 'Marek Vratka', guest_phone: '0903 555 666',
    }, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    expect((await adminReq(`/api/guest-orders/${refundGuest.order.id}/paid`, {
      method: 'patch', data: { paid: true },
    })).status(), 'admin marks the second guest paid').toBe(200)
    expect((await adminReq(`/api/guest-orders/${refundGuest.order.id}/cancel`, {
      method: 'post', data: {},
    })).status(), 'admin cancels it into the refund queue').toBe(200)

    const draftCart = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${draftFriend.id}`, {
      headers: draftFriend.auth,
      data: { items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
    })
    expect(draftCart.status(), 'the draft cart').toBe(200)
    const draftOrder = (await draftCart.json()).order

    const ghostGuest = await submitGuest(ghostLink.token, {
      guest_name: 'Zuzana Kolegova', guest_phone: '0904 777 888',
    }, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    return {
      host, bystander, ghostHost, draftFriend, cycle, product, link,
      friendOrder, draftOrder, unpaidGuest, refundGuest, ghostGuest,
    }
  })()
  return pl2Promise
}

test.describe('PL-T2 §UC-PL-003 item 1 — the guest payment block has ONE composer', () => {
  let fx = null
  test.beforeAll(async () => { fx = await pl2Fixtures() })

  test('the 201 grows the VS and the creditor name — and nothing it already carried moved', async () => {
    const created = fx.unpaidGuest
    // ⚠ BYTE-IDENTICAL PIN of the four shipped fields, by value and by key order.
    expect(created.payment).toEqual({
      amount: 20,
      reference: `G${created.order.id} / Jana Nezaplatena / ${fx.cycle.name}`,
      variable_symbol: guestVs(created.order.id),
      iban: PL2_IBAN,
      revolut_username: PL2_REVOLUT,
      creditor_name: PL2_CREDITOR,
    })
    expect(Object.keys(created.payment), 'the block grew, in place, by exactly two keys').toEqual([
      'amount', 'reference', 'variable_symbol', 'iban', 'revolut_username', 'creditor_name',
    ])
    // `amount` is still `order.total` (the module-20 seam has NOT moved).
    expect(created.payment.amount).toBe(created.order.total)
  })

  test('both status URL forms answer the SAME block as the 201, byte for byte', async () => {
    const created = fx.unpaidGuest
    const canonical = await ctx.get(`/api/guest/o/${created.order.order_token}`)
    expect(canonical.status(), 'the canonical status form').toBe(200)
    const pair = await ctx.get(`/api/guest/${fx.link.token}/orders/${created.order.order_token}`)
    expect(pair.status(), 'the legacy pair form').toBe(200)

    const fromCanonical = (await canonical.json()).payment
    const fromPair = (await pair.json()).payment
    // ⚠ JSON.stringify, not toEqual: ONE composer means the same keys in the same
    // ORDER on all three surfaces. Two hand-written blocks could pass `toEqual`.
    expect(JSON.stringify(fromCanonical), 'status payload vs the 201').toBe(JSON.stringify(created.payment))
    expect(JSON.stringify(fromPair), 'the pair form vs the canonical one').toBe(JSON.stringify(fromCanonical))
  })

  test('the PUBLIC listing still carries no payment data at all (06 §UC-GX-004)', async () => {
    const res = await ctx.get(`/api/guest/${fx.link.token}`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    // Non-vacuity: this really is the ordering payload.
    expect(Array.isArray(body.products), 'the listing carries the catalogue').toBe(true)
    expect(body.products.length).toBeGreaterThan(0)
    expect(body).not.toHaveProperty('payment')
    expect(JSON.stringify(body), 'no IBAN reaches the anonymous listing').not.toContain(PL2_IBAN)
    expect(JSON.stringify(body), 'no VS either').not.toContain(guestVs(fx.unpaidGuest.order.id))
  })

  test('a blank creditor name is an empty STRING on the block, never null or absent', async () => {
    await setCreditorName('')
    try {
      const res = await ctx.get(`/api/guest/o/${fx.unpaidGuest.order.order_token}`)
      expect(res.status()).toBe(200)
      const payment = (await res.json()).payment
      expect(payment.creditor_name, 'blank means no PayMe button, not a null in a template').toBe('')
      expect(payment.iban, 'the other settings are untouched by a blank name').toBe(PL2_IBAN)
      expect(payment.variable_symbol).toBe(guestVs(fx.unpaidGuest.order.id))
    } finally {
      await setCreditorName(PL2_CREDITOR)
    }
  })
})

test.describe('PL-T2 §UC-PL-003 item 3 — the friend order payload', () => {
  let fx = null
  test.beforeAll(async () => { fx = await pl2Fixtures() })

  test('GET/submit carry `payment: { variable_symbol }` — the bare order id, and nothing else', async () => {
    const res = await ctx.get(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.host.id}`, { headers: fx.host.auth })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.order.id, 'non-vacuity: there IS an order on this surface').toBe(fx.friendOrder.id)
    expect(body.payment).toEqual({ variable_symbol: String(fx.friendOrder.id) })
    // ⚠ DELIBERATE (§UC-PL-003 item 3): no IBAN here. `FriendOrder.vue` keeps its
    // `api.getPaymentSettings()` read, which is what `money-rounding.spec.js` mocks.
    expect(Object.keys(body.payment)).toEqual(['variable_symbol'])
    expect(JSON.stringify(body), 'the friend order payload carries no bank details').not.toContain(PL2_IBAN)
    // Derived, never a column on the order row.
    expect(body.order).not.toHaveProperty('variable_symbol')
    expect(body.order).not.toHaveProperty('payment')
  })

  test('the PUT and the submit answer the same VS as the GET', async () => {
    const put = await ctx.put(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.host.id}`, {
      headers: fx.host.auth,
      data: { items: [{ product_id: fx.product.id, variant: '250g', quantity: 2 }] },
    })
    expect(put.status()).toBe(200)
    expect((await put.json()).payment).toEqual({ variable_symbol: String(fx.friendOrder.id) })

    const submit = await ctx.post(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.host.id}/submit`, {
      headers: fx.host.auth, data: {},
    })
    expect(submit.status()).toBe(200)
    expect((await submit.json()).payment).toEqual({ variable_symbol: String(fx.friendOrder.id) })
  })

  test('no order means `payment: null` — on the GET and on the PUT that deletes one', async () => {
    const empty = await ctx.get(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.bystander.id}`, {
      headers: fx.bystander.auth,
    })
    expect(empty.status()).toBe(200)
    const emptyBody = await empty.json()
    expect(emptyBody.order, 'non-vacuity: this friend really has no order').toBeNull()
    expect(emptyBody.payment).toBeNull()

    // A cart created and then emptied: the PUT's `deleted` branch.
    const created = await ctx.put(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.bystander.id}`, {
      headers: fx.bystander.auth,
      data: { items: [{ product_id: fx.product.id, variant: '250g', quantity: 1 }] },
    })
    expect(created.status()).toBe(200)
    const createdBody = await created.json()
    expect(createdBody.order, 'non-vacuity: the draft exists before it is emptied').not.toBeNull()
    expect(createdBody.payment.variable_symbol).toBe(String(createdBody.order.id))

    const deleted = await ctx.put(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.bystander.id}`, {
      headers: fx.bystander.auth, data: { items: [] },
    })
    expect(deleted.status()).toBe(200)
    const deletedBody = await deleted.json()
    expect(deletedBody.order).toBeNull()
    expect(deletedBody.payment, 'the deleted branch says null, never an empty string VS').toBeNull()
  })
})

test.describe('PL-T2 §UC-PL-003 item 4 — the balance payment block', () => {
  let fx = null
  let debtor = null
  test.beforeAll(async () => {
    fx = await pl2Fixtures()
    debtor = await makeFriend('dlznik')
    const adj = await adminReq('/api/transactions/adjustment', {
      method: 'post',
      data: { friend_id: debtor.id, amount: PL2_BALANCE_DEBT, note: 'PL2 fixture' },
    })
    expect(adj.status(), 'the fixture debt').toBe(201)
    expect((await adj.json()).balance).toBeCloseTo(PL2_BALANCE_DEBT, 2)
  })

  test('a friend in debt is handed the whole block, with the balance VS and „{Meno} / zostatok“', async () => {
    const res = await ctx.get(`/api/friends/${debtor.id}/balance`, { headers: debtor.auth })
    expect(res.status()).toBe(200)
    const body = await res.json()
    // Nothing the shipped payload carried may be lost.
    expect(body.balance).toBeCloseTo(PL2_BALANCE_DEBT, 2)
    expect(Array.isArray(body.transactions), 'the transaction list is still there').toBe(true)
    expect(body.payment).toEqual({
      amount: 26.19,
      reference: `${debtor.name} / zostatok`,
      variable_symbol: balanceVs(debtor.id),
      iban: PL2_IBAN,
      revolut_username: PL2_REVOLUT,
      creditor_name: PL2_CREDITOR,
    })
  })

  test('a settled friend and a friend in credit are asked for nothing', async () => {
    const settled = await makeFriend('vyrovnany')
    const res = await ctx.get(`/api/friends/${settled.id}/balance`, { headers: settled.auth })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.balance).toBe(0)
    expect(body.payment.amount, 'a settled friend owes nothing').toBe(0)
    expect(body.payment.variable_symbol, 'the VS is still theirs').toBe(balanceVs(settled.id))

    expect((await adminReq('/api/transactions/adjustment', {
      method: 'post', data: { friend_id: settled.id, amount: 5, note: 'PL2 kredit' },
    })).status()).toBe(201)
    const credit = await ctx.get(`/api/friends/${settled.id}/balance`, { headers: settled.auth })
    const creditBody = await credit.json()
    expect(creditBody.balance).toBeCloseTo(5, 2)
    expect(creditBody.payment.amount, 'a friend in credit is never asked for money').toBe(0)
  })

  test('reading the block writes NO ledger row (the module-15 rule) and the boundary is unchanged', async () => {
    const before = await adminReq(`/api/friends/${debtor.id}/detail`)
    expect(before.status()).toBe(200)
    const countBefore = (await before.json()).transactions.length

    for (let i = 0; i < 3; i++) {
      expect((await ctx.get(`/api/friends/${debtor.id}/balance`, { headers: debtor.auth })).status()).toBe(200)
    }

    const after = await adminReq(`/api/friends/${debtor.id}/detail`)
    const afterBody = await after.json()
    expect(afterBody.transactions.length, 'no transaction row was written by a READ').toBe(countBefore)
    expect(countBefore, 'non-vacuity: the fixture debt row is actually counted').toBeGreaterThan(0)

    // SEC-A1: publishing the IBAN on this route did not loosen its ownership guard.
    const foreign = await ctx.get(`/api/friends/${debtor.id}/balance`, { headers: fx.host.auth })
    expect(foreign.status(), 'another friend may not read this balance').toBe(403)
    expect(JSON.stringify(await foreign.json()), 'and learns no payment data').not.toContain(PL2_IBAN)

    const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      const res = await anonymous.get(`/api/friends/${debtor.id}/balance`)
      expect(res.status(), 'anonymous stays out').toBe(401)
    } finally {
      await anonymous.dispose()
    }
  })
})

test.describe('PL-T2 §UC-PL-003 items 5+6 — the admin money surfaces', () => {
  let fx = null
  test.beforeAll(async () => { fx = await pl2Fixtures() })

  test('the unpaid overview and the refund queue carry the guest’s own VS', async () => {
    const res = await adminReq(`/api/guest-orders/cycle/${fx.cycle.id}/unpaid`)
    expect(res.status()).toBe(200)
    const body = await res.json()

    const unpaidRow = body.unpaid.find((row) => row.id === fx.unpaidGuest.order.id)
    expect(unpaidRow, 'non-vacuity: the unpaid guest is on the receivables list').toBeTruthy()
    // ⚠ THE CROSS-SURFACE PIN: the admin chasing the money and the guest paying it
    // read the SAME symbol, because they read the same helper.
    expect(unpaidRow.variable_symbol).toBe(fx.unpaidGuest.payment.variable_symbol)
    expect(unpaidRow.reference, 'the reference is untouched beside it').toBe(fx.unpaidGuest.payment.reference)

    const refundRow = body.refunds.find((row) => row.id === fx.refundGuest.order.id)
    expect(refundRow, 'non-vacuity: the cancelled paid order is on the refund queue').toBeTruthy()
    expect(refundRow.variable_symbol).toBe(fx.refundGuest.payment.variable_symbol)
    expect(refundRow.variable_symbol).toBe(guestVs(fx.refundGuest.order.id))
  })

  test('the orders tab carries a VS on friend rows and guest rows, and null on placeholders', async () => {
    const res = await adminReq(`/api/orders/cycle/${fx.cycle.id}`)
    expect(res.status()).toBe(200)
    const rows = await res.json()

    const hostRow = rows.find((row) => row.friend_id === fx.host.id)
    expect(hostRow, 'non-vacuity: the host row is listed').toBeTruthy()
    expect(hostRow.variable_symbol, 'a friend order pays under its own id').toBe(String(fx.friendOrder.id))

    const guestRow = (hostRow.guest_orders || []).find((sub) => sub.id === fx.unpaidGuest.order.id)
    expect(guestRow, 'non-vacuity: the sub-order is nested under its host').toBeTruthy()
    expect(guestRow.variable_symbol).toBe(fx.unpaidGuest.payment.variable_symbol)

    const placeholder = rows.find((row) => row.friend_id === fx.bystander.id)
    expect(placeholder, 'non-vacuity: a friend without an order is still listed').toBeTruthy()
    expect(placeholder.status, 'and really is a placeholder').toBe('none')
    expect(placeholder.id).toBeNull()
    expect(placeholder.variable_symbol, 'nothing to pay, so nothing to quote').toBeNull()

    // A DRAFT has an order id, so the payload carries its symbol — what the SCREEN
    // does with it is the view's decision (pinned in the UI block below).
    const draftRow = rows.find((row) => row.friend_id === fx.draftFriend.id)
    expect(draftRow, 'non-vacuity: the draft row is listed').toBeTruthy()
    expect(draftRow.status).toBe('draft')
    expect(draftRow.variable_symbol).toBe(String(fx.draftOrder.id))

    // The three schemes never meet on one screen.
    expect(hostRow.variable_symbol).not.toBe(guestRow.variable_symbol)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. PL-T2 §UC-PL-008 — the admin SEES it (CycleDetail, runs LAST: the browser
//    login retires this file's API token)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('PL-T2 §UC-PL-008 — „VS …“ on the receivables card and the orders tab', () => {
  let fx = null
  test.beforeAll(async () => { fx = await pl2Fixtures() })

  test.beforeEach(async ({ page }) => {
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)
    await page.goto(`/admin/cycle/${fx.cycle.id}`)
    await page.getByRole('tab', { name: 'Objednávky' }).click()
  })

  test('the receivables card prefixes the reference line with the VS', async ({ page }) => {
    const overview = page.getByTestId('guest-unpaid-overview')
    await expect(overview).toBeVisible()

    const unpaidRow = page.getByTestId(`guest-unpaid-row-${fx.unpaidGuest.order.id}`)
    await expect(unpaidRow, 'non-vacuity: the row under test is rendered').toBeVisible()
    await expect(unpaidRow.locator('.font-mono')).toHaveText(
      `VS ${fx.unpaidGuest.payment.variable_symbol} · ${fx.unpaidGuest.payment.reference}`
    )

    const refundRow = page.getByTestId(`guest-refund-row-${fx.refundGuest.order.id}`)
    await expect(refundRow).toBeVisible()
    await expect(refundRow.locator('.font-mono')).toHaveText(
      `VS ${fx.refundGuest.payment.variable_symbol} · ${fx.refundGuest.payment.reference}`
    )
  })

  test('the orders tab shows the VS on the friend row and on the nested guest row', async ({ page }) => {
    await expect(page.getByTestId(`order-vs-${fx.friendOrder.id}`)).toHaveText(`VS ${fx.friendOrder.id}`)
    const guestRow = page.getByTestId(`guest-suborder-${fx.unpaidGuest.order.id}`)
    await expect(guestRow).toBeVisible()
    await expect(guestRow.getByTestId(`guest-vs-${fx.unpaidGuest.order.id}`)).toHaveText(
      `VS ${fx.unpaidGuest.payment.variable_symbol}`
    )
  })

  // ⚠ The placeholder that is actually RENDERED: a host with no own order whose
  // colleague ordered through their link. They owe nothing themselves, so there is no
  // symbol to quote — while their guest's row right below carries one, which is what
  // makes this assertion non-vacuous.
  test('a placeholder row quotes nothing — it has nothing to pay', async ({ page }) => {
    const row = page.locator('tr').filter({ hasText: fx.ghostHost.name })
    await expect(row.first(), 'non-vacuity: the host without an own order is on the tab').toBeVisible()
    await expect(row.locator('[data-testid^="order-vs-"]'), 'no VS on a placeholder').toHaveCount(0)
    await expect(row.first()).not.toContainText('VS ')
    await expect(
      page.getByTestId(`guest-vs-${fx.ghostGuest.order.id}`),
      'while their colleague, who DOES owe money, is quoted one',
    ).toHaveText(`VS ${fx.ghostGuest.payment.variable_symbol}`)
  })

  // ⚠ A DRAFT IS NOT A DEBT. It has an `orders.id`, so the payload carries a symbol —
  // but this tab shows a draft „-“ for every figure (`isOrdered`, the one predicate),
  // and a VS on such a row would invite the admin to chase a payment nobody was asked
  // for. `guest-admin-view.spec.js:1237` pins that money cell as exactly „-“.
  test('a DRAFT cart quotes nothing either — the tab\u2019s one predicate decides', async ({ page }) => {
    const row = page.locator('tr').filter({ hasText: fx.draftFriend.name })
    await expect(row.first(), 'non-vacuity: the draft row is rendered').toBeVisible()
    await expect(row.first()).toContainText('Rozpracovane')
    await expect(row.locator(`[data-testid="order-vs-${fx.draftOrder.id}"]`)).toHaveCount(0)
    await expect(row.first()).not.toContainText('VS ')
  })

  // ⚠ ADMIN INVARIANCE (§UC-PL-008 AC). The friends theme is `:where(.app,.modal-layer)`;
  // an admin view that grew `.app`, a `neo/` primitive or a `pp-*` class would start
  // repainting under it. Asserted BOTH ways: in the DOM, and on the source of the one
  // file this row edits.
  test('⚠ the admin cycle detail picked up no friends-theme styling', async ({ page }) => {
    await expect(page.locator('.app')).toHaveCount(0)
    await expect(page.locator('.modal-layer')).toHaveCount(0)
    for (const cls of ['.cartbar', '.appbar', '.statuspill', '.field-lbl', '.copyrow', '.vbox', '.cat-tabs']) {
      await expect(page.locator(cls), `no ${cls} on the cycle detail`).toHaveCount(0)
    }

    test.skip(!CAN_IMPORT_HELPER, NEEDS_SOURCE)
    const source = fs.readFileSync(CYCLE_DETAIL_VIEW, 'utf8')
    expect(source, 'non-vacuity: the file this row edits really was read').toContain('guest-unpaid-overview')
    expect(source, 'the VS did land in this file').toContain('VS ')
    for (const forbidden of ['components/neo/', 'friends-theme', 'class="pp-', "'pp-", ' pp-']) {
      expect(source.includes(forbidden), `CycleDetail.vue must not use ${forbidden}`).toBe(false)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. §UC-PL-004 (PL-T3) — `frontend/src/lib/payment-links.js`, the client home
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ WHY THE THREE BUILDERS ARE DRIVEN IN A CHILD PROCESS AND NOT ONLY THROUGH THE
// RENDERED MODAL. The surfaces prove the component calls the helper with the right
// props; they cannot reach the inputs that decide whether the helper is SAFE — a
// creditor name carrying `&`/`#`/a newline (the hand-off PL-T1 recorded in writing:
// the name is validated for LENGTH ONLY), a zero or absent amount, a blank handle, and
// the `REVOLUT_AMOUNT_LINK` flag turned off. `payment-links.js` is deliberately free of
// the `@/` Vite alias for exactly this reason, so a plain `node` can import it.
//
// ⚠ THE ENCODING ASSERTION THAT ACTUALLY BITES IS THE PARAMETER KEY SET, not the value.
// `new URL(href).searchParams.get('CN')` round-trips correctly even from a link that was
// built by raw interpolation of a name WITHOUT an `&` in it — so the hostile fixture
// carries one, and the test asserts the link has EXACTLY the eight documented keys. A
// raw `CN=${name}` grows a ninth and fails; nothing weaker would.

const FRONTEND_SRC = path.resolve(E2E_DIR, '../frontend/src')
const LINKS_ENTRY = path.join(FRONTEND_SRC, 'lib/payment-links.js')
const MONEY_ENTRY = path.join(FRONTEND_SRC, 'lib/money.js')
const FRONTEND_NODE_MODULES = path.resolve(E2E_DIR, '../frontend/node_modules')
const ROUTER_ENTRY = path.join(FRONTEND_SRC, 'router.js')
const PAYMENT_MODAL = path.join(FRONTEND_SRC, 'components/PaymentModal.vue')
// ⚠ The GATE is the frontend SOURCE TREE, never `payment-links.js` itself — "the helper
// is missing" must be a RED run, not a silent skip (the vacuity trap the `DB_PATH`
// self-skips have). Against a deployment there is no source beside `e2e/` and the whole
// section skips honestly.
const CAN_IMPORT_LINKS = fs.existsSync(FRONTEND_SRC) && fs.existsSync(FRONTEND_NODE_MODULES)
const NEEDS_FRONTEND = 'needs the frontend source + node_modules beside e2e/ (skipped against a deployment)'

// ⚠ THE HOSTILE NAME IS THE POINT OF THIS SECTION. Every character here is legal in the
// `payment_creditor_name` setting today (70-char bound, no character rule) and every one
// of them means something in a query string: `&` ends a parameter, `#` starts a fragment
// and truncates everything after it, `+` decodes back as a SPACE, `%` starts an escape
// and `=` splits key from value. The newline is the control character the bound does not
// see. 70 characters or fewer, so it is a name the admin can really save.
const HOSTILE_CREDITOR = 'A & B #1 +50% =x\nKaviareň'
const HOSTILE_HANDLE = 'kar ol&x#y'
const PAYME_KEYS = ['V', 'IBAN', 'AM', 'CC', 'DT', 'PI', 'MSG', 'CN']

let links = null
let linksFlagOff = null

/** `YYYYMMDD` for today, the derivation both encode sites shipped with. */
function todayCompact() {
  const t = new Date()
  return t.getFullYear().toString()
    + (t.getMonth() + 1).toString().padStart(2, '0')
    + t.getDate().toString().padStart(2, '0')
}

/**
 * Drives the three builders in a throwaway `node`, against the module at `entryUrl`.
 * Unlike the backend probe this one opens no database — the module is pure.
 */
async function runLinks(entryUrl) {
  const script = [
    "const m = await import(process.env.LINKS_URL)",
    "const hostile = process.env.HOSTILE_CREDITOR",
    "const hostileHandle = process.env.HOSTILE_HANDLE",
    "const out = {",
    "  flag: m.REVOLUT_AMOUNT_LINK,",
    "  exports: Object.keys(m).sort(),",
    "  revolut: {",
    "    withAmount: m.revolutLink('karolskolar', 26.19),",
    "    atStripped: m.revolutLink('@karolskolar', 26.19),",
    "    padded: m.revolutLink('  karolskolar  ', 26.19),",
    "    drift: m.revolutLink('karolskolar', 15 + 11.19),",
    "    noAmount: m.revolutLink('karolskolar'),",
    "    zero: m.revolutLink('karolskolar', 0),",
    "    negative: m.revolutLink('karolskolar', -3),",
    "    nan: m.revolutLink('karolskolar', NaN),",
    "    stringAmount: m.revolutLink('karolskolar', '26.19'),",
    "    blank: m.revolutLink('   ', 26.19),",
    "    missing: m.revolutLink(undefined, 26.19),",
    "    atOnly: m.revolutLink('@', 26.19),",
    "    hostile: m.revolutLink(hostileHandle, 26.19),",
    "    sub1c: m.revolutLink('karolskolar', 0.004),",
    "  },",
    "  payme: {",
    "    full: m.paymeLink({ iban: 'SK31 1200 0000 1987 4263 7541', amount: 26.19, variableSymbol: '9000123', reference: 'G123 / Marek / Cyklus 7', creditorName: 'Karol Skolar', date: '20260919' }),",
    "    lowerIban: m.paymeLink({ iban: 'sk3112000000198742637541', amount: 26.19, variableSymbol: '9000123', reference: 'R', creditorName: 'Karol Skolar', date: '20260919' }),",
    "    noVs: m.paymeLink({ iban: 'SK3112000000198742637541', amount: 26.19, variableSymbol: '', reference: 'R', creditorName: 'Karol Skolar', date: '20260919' }),",
    "    noReference: m.paymeLink({ iban: 'SK3112000000198742637541', amount: 26.19, variableSymbol: '9000123', reference: '', creditorName: 'Karol Skolar', date: '20260919' }),",
    "    drift: m.paymeLink({ iban: 'SK3112000000198742637541', amount: 15 + 11.19, variableSymbol: '9000123', reference: 'R', creditorName: 'Karol Skolar', date: '20260919' }),",
    "    longReference: m.paymeLink({ iban: 'SK3112000000198742637541', amount: 26.19, variableSymbol: '9000123', reference: 'x'.repeat(400), creditorName: 'Karol Skolar', date: '20260919' }),",
    "    hostile: m.paymeLink({ iban: 'SK3112000000198742637541', amount: 26.19, variableSymbol: '9000123', reference: 'G1 & G2 #3', creditorName: hostile, date: '20260919' }),",
    "    hostileVs: m.paymeLink({ iban: 'SK3112000000198742637541', amount: 26.19, variableSymbol: '9/0&0#1', reference: 'R', creditorName: 'Karol Skolar', date: '20260919' }),",
    "    today: m.paymeLink({ iban: 'SK3112000000198742637541', amount: 26.19, variableSymbol: '9000123', reference: 'R', creditorName: 'Karol Skolar' }),",
    "    blankCreditor: m.paymeLink({ iban: 'SK3112000000198742637541', amount: 26.19, variableSymbol: '9000123', reference: 'R', creditorName: '   ' }),",
    "    missingCreditor: m.paymeLink({ iban: 'SK3112000000198742637541', amount: 26.19, variableSymbol: '9000123', reference: 'R' }),",
    "    blankIban: m.paymeLink({ iban: '', amount: 26.19, creditorName: 'Karol Skolar' }),",
    "    zeroAmount: m.paymeLink({ iban: 'SK3112000000198742637541', amount: 0, creditorName: 'Karol Skolar' }),",
    "    nanAmount: m.paymeLink({ iban: 'SK3112000000198742637541', amount: NaN, creditorName: 'Karol Skolar' }),",
    "    missingAmount: m.paymeLink({ iban: 'SK3112000000198742637541', creditorName: 'Karol Skolar' }),",
    "    noArgs: m.paymeLink(),",
    "  },",
    "  payload: {",
    "    shipped: m.payBySquarePayload({ amount: 26.19, iban: 'SK31 1200 0000 1987 4263 7541', reference: 'G1 / Marek / C', date: '20260919' }),",
    "    full: m.payBySquarePayload({ amount: 15 + 11.19, iban: 'SK31 1200 0000 1987 4263 7541', variableSymbol: '9000123', reference: 'G1 / Marek / C', creditorName: hostile, date: '20260919' }),",
    "    today: m.payBySquarePayload({ amount: 26.19, iban: 'SK3112000000198742637541' }),",
    "  },",
    "}",
    // The non-string IBAN must still THROW — that is the arm `guest-payment-modal.spec.js`
    // drives to paint the shipped error copy instead of an empty ink frame.
    "try { m.payBySquarePayload({ amount: 1, iban: 123456 }); out.nonStringIban = 'no throw' }",
    "catch (e) { out.nonStringIban = 'threw' }",
    "process.stdout.write('\\nLINKS_RESULT:' + JSON.stringify(out) + '\\n')",
  ].join('\n')

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      LINKS_URL: entryUrl,
      HOSTILE_CREDITOR,
      HOSTILE_HANDLE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', (c) => { output += c })
  child.stderr.on('data', (c) => { output += c })
  const exitCode = await new Promise((resolve) => child.on('exit', resolve))

  const match = output.match(/LINKS_RESULT:(.*)/)
  if (exitCode !== 0 || !match) {
    throw new Error(`lib/payment-links.js could not be driven (exit ${exitCode}):\n${output}`)
  }
  return JSON.parse(match[1])
}

/**
 * The SAME module with `REVOLUT_AMOUNT_LINK` flipped to `false`, imported from a
 * throwaway directory.
 *
 * ⚠ This is the proof of the promise the spec makes about R6.1 — "if the amount variant
 * does not prefill on a real phone, the fallback is ONE line in ONE place". A test that
 * merely read the constant would prove nothing about what flipping it does. The copy
 * sits in `os.tmpdir()` with a `node_modules` SYMLINK to the frontend's, so `bysquare`
 * resolves and NOTHING is written into the repo (a leftover probe file under
 * `frontend/src/lib/` would be a second home for this module, which is the one thing
 * §UC-PL-004 exists to prevent).
 */
async function runLinksWithFlagOff() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gorifi-links-${uniq}-`))
  try {
    const source = fs.readFileSync(LINKS_ENTRY, 'utf8')
    const needle = 'export const REVOLUT_AMOUNT_LINK = true'
    // Non-vacuity: if the declaration is written any other way the substitution below is
    // a no-op and the test would "pass" against the flag still on.
    expect(source.split(needle).length - 1, 'exactly one `REVOLUT_AMOUNT_LINK = true` to flip').toBe(1)
    fs.writeFileSync(path.join(dir, 'payment-links.js'), source.replace(needle, 'export const REVOLUT_AMOUNT_LINK = false'))
    fs.copyFileSync(MONEY_ENTRY, path.join(dir, 'money.js'))
    fs.symlinkSync(FRONTEND_NODE_MODULES, path.join(dir, 'node_modules'), 'dir')
    return await runLinks(pathToFileURL(path.join(dir, 'payment-links.js')).href)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test.describe('PL-T3 §UC-PL-004 — lib/payment-links.js, the one client home', () => {
  test.skip(!CAN_IMPORT_LINKS, NEEDS_FRONTEND)

  test.beforeAll(async () => {
    links = await runLinks(pathToFileURL(LINKS_ENTRY).href)
    linksFlagOff = await runLinksWithFlagOff()
  })

  test('it exports exactly the four documented names', () => {
    expect(links.exports).toEqual(['REVOLUT_AMOUNT_LINK', 'paymeLink', 'payBySquarePayload', 'revolutLink'].sort())
    expect(links.flag, 'shipped ON — the amount variant is the default (R6.1)').toBe(true)
  })

  // ── revolutLink ────────────────────────────────────────────────────────────
  test('revolutLink: the amount variant is MINOR units, rounded before the conversion', () => {
    expect(links.revolut.withAmount).toBe('https://revolut.me/karolskolar?amount=2619&currency=EUR')
    // The float-drift shape from `money.js`'s header: 15 + 11.19 = 26.189999999999998.
    // Unrounded, `Math.round(x * 100)` would still give 2619 — so the assertion that
    // earns its keep is the sub-cent one below, where the two disagree.
    expect(links.revolut.drift).toBe('https://revolut.me/karolskolar?amount=2619&currency=EUR')
    expect(links.revolut.sub1c, 'under a cent rounds to 0 minor units, not to 0.4').toBe('https://revolut.me/karolskolar?amount=0&currency=EUR')
  })

  test('revolutLink: `@` stripped, whitespace trimmed, and the plain profile link for a non-amount', () => {
    expect(links.revolut.atStripped).toBe('https://revolut.me/karolskolar?amount=2619&currency=EUR')
    expect(links.revolut.padded).toBe('https://revolut.me/karolskolar?amount=2619&currency=EUR')
    for (const key of ['noAmount', 'zero', 'negative', 'nan', 'stringAmount']) {
      expect(links.revolut[key], `${key} falls back to the shipped profile link`).toBe('https://revolut.me/karolskolar')
    }
  })

  test('revolutLink: a blank handle yields `\'\'` — the shipped render gate', () => {
    expect(links.revolut.blank).toBe('')
    expect(links.revolut.missing).toBe('')
    expect(links.revolut.atOnly, 'an `@` alone is not a handle').toBe('')
  })

  test('⚠ revolutLink ENCODES the handle — it is never interpolated raw', () => {
    // `kar ol&x#y`: the space, the `&` and the `#` all change what the URL means.
    expect(links.revolut.hostile).toBe(`https://revolut.me/${encodeURIComponent(HOSTILE_HANDLE)}?amount=2619&currency=EUR`)
    const url = new URL(links.revolut.hostile)
    expect(decodeURIComponent(url.pathname.slice(1)), 'round-trips to the stored handle').toBe(HOSTILE_HANDLE)
    expect(url.hash, 'the `#` did not open a fragment').toBe('')
    expect([...url.searchParams.keys()], 'the `&` did not invent a parameter').toEqual(['amount', 'currency'])
  })

  // ── the flag ───────────────────────────────────────────────────────────────
  test('⚠ REVOLUT_AMOUNT_LINK=false is a ONE-LINE fallback to the shipped profile link', () => {
    expect(linksFlagOff.flag).toBe(false)
    for (const key of ['withAmount', 'atStripped', 'drift', 'sub1c']) {
      expect(linksFlagOff.revolut[key], `${key} drops the amount entirely`).toBe('https://revolut.me/karolskolar')
    }
    // Everything else is untouched by the flag — it gates the amount, not the link.
    expect(linksFlagOff.revolut.blank).toBe('')
    expect(linksFlagOff.payme.full, 'PayMe does not ride on the Revolut flag').toBe(links.payme.full)
    expect(linksFlagOff.payload.full).toEqual(links.payload.full)
  })

  // ── paymeLink ──────────────────────────────────────────────────────────────
  test('paymeLink: the exact documented parameter set, in order', () => {
    // ⚠ THE `PI` SLASHES ARE BARE, AND THAT IS THE POINT OF WRITING THIS OUT RAW.
    // `/` is legal unencoded in a query string, §UC-PL-006 writes the triplet literally,
    // and a bank app that splits the RAW query instead of URL-decoding it would read
    // `%2FVS…%2FSS%2FKS` verbatim — a malformed identifier on the one field that makes a
    // statement match a person. A parsed assertion CANNOT see this (`searchParams.get`
    // decodes, so both forms look identical), so the raw string is the only witness.
    expect(links.payme.full).toBe(
      'https://payme.sk/?V=1&IBAN=SK3112000000198742637541&AM=26.19&CC=EUR&DT=20260919'
      + '&PI=/VS9000123/SS/KS'
      + `&MSG=${encodeURIComponent('G123 / Marek / Cyklus 7')}`
      + '&CN=Karol%20Skolar',
    )
    // Stated a second way, segment by segment, so a change to any OTHER parameter cannot
    // be "fixed" by rewriting the whole literal above without noticing this one.
    const rawParams = links.payme.full.split('?')[1].split('&')
    expect(rawParams.find((p) => p.startsWith('PI=')), 'structure bare, value encoded')
      .toBe('PI=/VS9000123/SS/KS')
    const url = new URL(links.payme.full)
    expect(url.origin + url.pathname).toBe('https://payme.sk/')
    expect([...url.searchParams.keys()]).toEqual(PAYME_KEYS)
    expect(url.searchParams.get('AM'), 'two decimals, always').toBe('26.19')
    expect(url.searchParams.get('CC')).toBe('EUR')
    expect(url.searchParams.get('PI')).toBe('/VS9000123/SS/KS')
    expect(url.searchParams.get('MSG')).toBe('G123 / Marek / Cyklus 7')
    expect(url.searchParams.get('CN')).toBe('Karol Skolar')
  })

  test('paymeLink: IBAN whitespace-free and upper-cased; the amount rounded, then formatted', () => {
    expect(new URL(links.payme.lowerIban).searchParams.get('IBAN')).toBe('SK3112000000198742637541')
    // 15 + 11.19 = 26.189999999999998 — `toFixed(2)` would hide it, but the QR beside it
    // would carry the noise, so the rounding happens before both.
    expect(new URL(links.payme.drift).searchParams.get('AM')).toBe('26.19')
  })

  test('paymeLink: no VS ⇒ no `PI` at all; no reference ⇒ no `MSG`; the message is capped at 140', () => {
    expect([...new URL(links.payme.noVs).searchParams.keys()], 'an empty `PI=/VS/SS/KS` is malformed, not absent')
      .toEqual(['V', 'IBAN', 'AM', 'CC', 'DT', 'MSG', 'CN'])
    expect([...new URL(links.payme.noReference).searchParams.keys()])
      .toEqual(['V', 'IBAN', 'AM', 'CC', 'DT', 'PI', 'CN'])
    expect(new URL(links.payme.longReference).searchParams.get('MSG')).toBe('x'.repeat(140))
  })

  test('paymeLink: `DT` defaults to today, the same derivation the QR uses', () => {
    expect(new URL(links.payme.today).searchParams.get('DT')).toBe(todayCompact())
    expect(links.payload.today.payments[0].paymentDueDate, 'and the QR agrees').toBe(todayCompact())
  })

  test('paymeLink: NO link without a creditor name, an IBAN and a positive amount', () => {
    for (const key of ['blankCreditor', 'missingCreditor', 'blankIban', 'zeroAmount', 'nanAmount', 'missingAmount', 'noArgs']) {
      expect(links.payme[key], `${key} must not produce a PayMe link`).toBe('')
    }
  })

  test('⚠ paymeLink ENCODES the creditor name and the reference — the PL-T1 hand-off', () => {
    // The name is validated for LENGTH ONLY on the server (no character rule), so this
    // is the only place `&`, `#`, `+`, `%` and a newline are made safe.
    const url = new URL(links.payme.hostile)
    // THE assertion: a raw `CN=${name}` would split on the `&` and grow a ninth key
    // (and the `#` would truncate the link into a fragment). Eight keys, exactly.
    expect([...url.searchParams.keys()], 'raw interpolation would invent parameters').toEqual(PAYME_KEYS)
    expect(url.hash, 'the `#` in the name did not open a fragment').toBe('')
    expect(url.searchParams.get('CN'), 'and it round-trips to the stored name').toBe(HOSTILE_CREDITOR)
    expect(url.searchParams.get('MSG')).toBe('G1 & G2 #3')
    // `+` in a query string decodes as a SPACE; `%` starts an escape. Both must be
    // percent-encoded in the raw href, not merely survive a lenient parse.
    expect(links.payme.hostile).toContain(`CN=${encodeURIComponent(HOSTILE_CREDITOR)}`)
    expect(links.payme.hostile).not.toContain('+50%')
    expect(links.payme.hostile.split('\n'), 'no raw newline in a URL').toHaveLength(1)
  })

  test('⚠ paymeLink encodes the VALUE inside `PI` while leaving the STRUCTURE bare', () => {
    // The converse of the test above, and the distinction the over-encoding fix turned
    // on: encode values, never structure. A symbol carrying `/`, `&` and `#` must not be
    // able to forge a triplet, invent a parameter or open a fragment — while the two
    // slashes that ARE the triplet stay literal.
    const raw = links.payme.hostileVs.split('?')[1].split('&')
    expect(raw.find((p) => p.startsWith('PI=')))
      .toBe(`PI=/VS${encodeURIComponent('9/0&0#1')}/SS/KS`)
    const url = new URL(links.payme.hostileVs)
    expect([...url.searchParams.keys()], 'the `&` in the symbol invented nothing').toEqual(PAYME_KEYS)
    expect(url.hash, 'the `#` in the symbol opened no fragment').toBe('')
    expect(url.searchParams.get('PI'), 'and it round-trips').toBe('/VS9/0&0#1/SS/KS')
  })

  // ── payBySquarePayload ─────────────────────────────────────────────────────
  test('payBySquarePayload: byte-identical to the shipped payload when VS and creditor name are absent', () => {
    // ⚠ The independent statement of the shipped object. If this literal and the helper
    // ever disagree, `money-rounding.spec.js` and `guest-payment-modal.spec.js` will be
    // reading a QR nobody wrote on purpose.
    expect(links.payload.shipped).toEqual({
      invoiceId: '',
      payments: [{
        type: 1,
        amount: 26.19,
        currencyCode: 'EUR',
        paymentDueDate: '20260919',
        variableSymbol: '',
        constantSymbol: '',
        specificSymbol: '',
        originatorsReferenceInformation: '',
        paymentNote: 'G1 / Marek / C',
        bankAccounts: [{ iban: 'SK3112000000198742637541', bic: '' }],
        beneficiary: { name: 'Gorifi', street: '', city: '' },
      }],
    })
    // Ordered keys too: `bysquare` serialises what it is given, and an added field is as
    // much a payload change as a removed one.
    expect(Object.keys(links.payload.shipped.payments[0])).toEqual([
      'type', 'amount', 'currencyCode', 'paymentDueDate', 'variableSymbol', 'constantSymbol',
      'specificSymbol', 'originatorsReferenceInformation', 'paymentNote', 'bankAccounts', 'beneficiary',
    ])
  })

  test('payBySquarePayload: EXACTLY two fields change — the symbol and the beneficiary', () => {
    const shipped = links.payload.shipped.payments[0]
    const full = links.payload.full.payments[0]
    const differing = Object.keys(full).filter((k) => JSON.stringify(full[k]) !== JSON.stringify(shipped[k]))
    expect(differing.sort()).toEqual(['beneficiary', 'variableSymbol'])
    expect(full.variableSymbol).toBe('9000123')
    // D3 — the QR and the PayMe link must not name two different payees in one app. The
    // name is NOT url-encoded here: this is a payload field, not a URL.
    expect(full.beneficiary).toEqual({ name: HOSTILE_CREDITOR, street: '', city: '' })
    expect(full.amount, 'and the drift is still rounded away').toBe(26.19)
    expect(full.paymentNote, 'the reference stays the server’s, verbatim').toBe('G1 / Marek / C')
  })

  test('⚠ a non-string IBAN still THROWS — the caller’s error arm stays reachable', () => {
    expect(links.nonStringIban).toBe('threw')
  })

  // ── the boundary ───────────────────────────────────────────────────────────
  test('⚠ NO admin view imports payment-links.js or PaymentModal.vue', () => {
    // The admin set is read off `router.js` rather than a hand-kept list, so a new admin
    // screen joins this sweep the day it is routed.
    const router = fs.readFileSync(ROUTER_ENTRY, 'utf8')
    const adminViews = [...router.matchAll(/path:\s*'(\/admin[^']*)'[\s\S]{0,300}?import\('\.\/views\/([A-Za-z0-9]+\.vue)'\)/g)]
      .map((m) => m[2])
    expect(new Set(adminViews).size, 'non-vacuity: the admin routes were really parsed').toBeGreaterThan(8)

    const offenders = [...new Set(adminViews)].filter((view) => {
      const file = path.join(FRONTEND_SRC, 'views', view)
      if (!fs.existsSync(file)) return false
      const src = fs.readFileSync(file, 'utf8')
      return src.includes('payment-links') || src.includes('PaymentModal')
    })
    expect(offenders, 'lib/money.js is friend/guest-only, and so is everything built on it').toEqual([])

    // The other half: the component that DOES consume it really does (or the sweep above
    // is a tautology over a module nobody imports).
    expect(fs.readFileSync(PAYMENT_MODAL, 'utf8')).toContain('payment-links')
  })
})
