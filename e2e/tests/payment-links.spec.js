import { test, expect, request as playwrightRequest } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'

// PL-T1 — module 15 §UC-PL-001 (the ONE server home for a variable symbol) and
// §UC-PL-002 (the admin setting `payment_creditor_name`).
//
// This file is STARTED here and GROWN by PL-T2/T3/T4 (payload VS, the client link
// composition, the friend surfaces). At this stage it pins two things only: the
// derivation rules of `backend/src/helpers/payment.js`, and the new setting.
//
// ⚠ WHY THE VS RULES ARE TESTED THROUGH A CHILD PROCESS AND NOT THROUGH A PAYLOAD.
// The VS is DERIVED, never stored (decision D1), and PL-T1 deliberately does not put
// it into any response yet — PL-T2 owns that. The rules are nevertheless money rules,
// and the one that matters most (a friend id and a guest id must NEVER map onto the
// same number) is invisible from any single payload: it is a statement about three
// functions at once. So the helper is imported in a throwaway `node` process against a
// throwaway DB file — the `google-auth-verifier.spec.js` / `catalog-foundation.spec.js`
// idiom — and every derivation is read off the real module, not re-implemented here.
//
// ⚠ THE GATE IS THE BACKEND SOURCE, NOT `payment.js` ITSELF. "The helper is missing"
// must be a RED run, not a silent skip (the vacuity trap the `DB_PATH` self-skips have).
//
// ⚠ Ordering inside the file: the API block reads the SEEDED creditor name before it
// mutates anything, and the UI block runs LAST because a UI admin login invalidates the
// single app-wide admin session (the `admin-friends-labels.spec.js` note), so the API
// context's token would go dead under it. The restore step re-logs-in for that reason.

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND_ENTRY = path.resolve(E2E_DIR, '../backend/src/index.js')
const HELPER_ENTRY = path.resolve(E2E_DIR, '../backend/src/helpers/payment.js')
const BACKEND_SRC = path.resolve(E2E_DIR, '../backend/src')
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
    "const maxCreditorNameLength = mod.MAX_CREDITOR_NAME_LENGTH",
    "process.stdout.write('\\nPAYMENT_RESULT:' + JSON.stringify({ vs, settings, block, maxCreditorNameLength }) + '\\n')",
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
