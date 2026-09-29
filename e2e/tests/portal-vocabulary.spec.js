import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'
import { collectAllCopy, collectAppCopy, collectMarkedData } from '../helpers/copy-sweep.js'
import { assertReadable, FRONTEND_SRC, HAS_SRC, NEEDS_SRC, stripComments } from '../helpers/source-pins.js'
import {
  ackExplainer, dismissLandingState, drawer, expectLanding, gotoCycle,
  landingStateModal, openInvite, openMenu, openProfile,
} from '../helpers/portal.js'
import {
  BANNED, BANNED_CASES, FRIEND_SURFACE_ROOTS, GUEST_SURFACE_ROOTS, VOCABULARY_ROOTS, bannedLines, importClosure,
} from '../helpers/vocabulary.js'

// PI-T11 — 18 §UC-PI-017 (the vocabulary rule, its guard and its copy-edit table) and
// §UC-PI-018 (the `/cycle/:id` deep link).
//
// ── WHAT THIS FILE IS ────────────────────────────────────────────────────────
// §16 / the 00-overview glossary: the words „cyklus" and „kolo" never reach a friend.
// „objednávka" is the word for a round. „cyklus" survives on ADMIN screens.
//
// The rule is asserted at three altitudes, and all three are needed:
//   §1 the REGEX — one home, one union, proved on a table of cases;
//   §2 the SOURCE — every file that can reach a friend's screen, DERIVED not listed;
//   §3 the SERVER — the 4xx messages a friend can read;
//   §4 the RENDERED PAGE — every view, state and modal of module 18.
// §5 is §UC-PI-018's regression net for the deep link, which is where most of the
// re-worded copy lives.
// §6 (GL-T7, 19 §UC-GL-011 — the module-19 closeout) widens all three altitudes to the
// GUEST surface: the `/g/…` routes' import closure, the guest-facing server messages
// (`routes/guest.js`, the host 409s of `routes/guest-orders.js`), and the guest screens
// that render them. The new strings are PO DRAFTS (learnings 11 §GL-T7).
//
// ⚠ §2 AND §4 ANSWER DIFFERENT QUESTIONS. Source can hold a banned word in a branch
// no fixture reaches; the page can hold one that came from the SERVER (a 4xx banner)
// or from a composed sentence no single file contains. Neither subsumes the other.
//
// ⚠⚠ THE ONE FORBIDDEN REPAIR. `helpers/copy-sweep.js` drops `[data-user-copy]`
// subtrees, because a sweep asserts what the APP calls things, never what an admin
// TYPED. This suite's own fixtures create cycles literally named „… cyklus" and this
// file creates one named „…kolo cyklus…" ON PURPOSE (§4.4 proves the exclusion with
// it). If this sweep ever reddens on a value a person typed, mark THAT render with
// `data-user-copy` — never narrow the regex. Narrowing is how the original
// „Prihlasovacie meno" defect was nearly laundered (FUP-T22).

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

/**
 * A cycle name that says BOTH banned words, so every screen that renders a cycle name
 * is carrying a live offender the sweep must NOT see. This is the FUP-T22 idiom: the
 * exclusion is proved against data that would red the guard, not asserted on faith.
 */
const POISON = `PI11 kolo cyklus ${uniq}`

let ctx = null
let adminToken = ''

const admin = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
  timeout: TIMEOUT,
})

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => { await ctx?.dispose() })

let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `pi11_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `PI11 ${label} ${uniq}`
  // ⚠ `phone` (PI-T10): without one the profile modal auto-opens over whatever screen
  // this file came to sweep, and its scrim eats the appbar.
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: '0900 111 222' } })
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
  // ⚠ 18 §UC-PI-013 (PI-T9): an unacknowledged friend lands on `/ako-to-funguje`.
  await ackExplainer(ctx, { id: row.id, token })
  return { id: row.id, name, username, token }
}

async function makeCycle(name, data = {}) {
  const res = await admin('/api/cycles', {
    method: 'post', data: { name, type: 'coffee', status: 'open', ...data },
  })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

const friendCall = (friend, path, data, method = 'put') => ctx[method](path, {
  headers: { Authorization: `Bearer ${friend.token}` }, data, timeout: TIMEOUT,
})

async function signIn(page, friend) {
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({
    friendId: friend.id,
    friendName: friend.name,
    token: friend.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  }))
}

/** Land on a portal route with `GET /friends/cycles` already answered (PI-T3's idiom). */
async function open(page, path = '/') {
  const served = page.waitForResponse((r) => r.url().includes('/api/friends/cycles'), { timeout: TIMEOUT })
  await page.goto(path)
  await served
  await expectLanding(page)
}

/** A cycle row shaped like `GET /friends/cycles` publishes one (for STATE fixtures). */
const cycleRow = (over) => ({
  id: 89_000 + (over.n || 0), name: `PI11 Stub ${over.n || 0}`, status: 'planned',
  created_at: over.created_at || `2026-09-0${(over.n || 1) % 9 + 1} 10:00:00`,
  total_friends: 0, expected_date: null, type: 'coffee', plan_note: null,
  opens_at: null, closes_at: null, stage: null, parcel_enabled: 0, parcel_fee: 0,
  hasOrder: false, orderTotal: 0, orderStatus: null, orderKilos: 0, orderItemCount: 0,
  orderPickupName: null, orderPacketa: false, orderPaid: false, orderHandedOver: false,
  ...over,
})

/**
 * The landing's round is resolved from `GET /friends/cycles` and OPEN beats LOCKED
 * (§UC-PI-002) — and this suite always has somebody else's open cycle in the database.
 * So a test that needs a specific STATE stubs the payload, while keeping the REAL id
 * so `FriendOrder` still loads a real order and a real grid underneath it.
 */
const lockedRow = (cycle, over = {}) => cycleRow({
  id: cycle.id, name: cycle.name, status: 'locked', created_at: '2026-09-10 10:00:00', ...over,
})

async function stubCycles(page, cycles) {
  await page.route('**/api/friends/cycles*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(cycles),
  }))
}

/**
 * The app's own copy on screen right now, asserted CLEAN — with its own non-vacuity
 * gate, because an absence over an empty string passes for the wrong reason.
 *
 * @param page
 * @param where  what is on screen, for the failure message
 * @param mustSay  app strings this screen really renders. IDENTITY, not a count:
 *                 a length threshold below the real length can never fire (CS-T2's
 *                 gate shipped at 30 against a real 54 and was decorative).
 */
async function expectCleanCopy(page, where, mustSay) {
  expect(Array.isArray(mustSay) && mustSay.length > 0,
    `${where}: a sweep with no non-vacuity gate proves nothing`).toBe(true)
  // ⚠ CASE-INSENSITIVE, and that is the standing `innerText` trap, not laziness:
  // `innerText` applies `text-transform`, so the appbar's „Podpultovka" arrives as
  // „PODPULTOVKA" and a literal gate would fail on a screen it read perfectly. The
  // BAN below is case-insensitive for the same reason (`/i`).
  //
  // ⚠ POLLED, because the gate doubles as the „screen is ready" wait. A one-shot read
  // measured red once (PI-T11 resume): the deep link's appbar title paints BEFORE
  // `FriendOrder` finishes loading, so a sweep taken right after the title assertion
  // read „Načítavam..." instead of the locked screen. The poll waits for every
  // `mustSay` phrase and THEN the ban is asserted on that same snapshot — it still
  // fails (after `expect.timeout`) on a screen that never says them.
  let copy = ''
  await expect.poll(async () => {
    copy = await page.evaluate(collectAppCopy())
    const haystack = copy.toLowerCase()
    return mustSay.filter((phrase) => !haystack.includes(phrase.toLowerCase()))
  }, { message: `${where}: the sweep really read this screen (phrases missing from it)` }).toEqual([])
  const offenders = copy.split('\n').map((l) => l.trim()).filter((l) => BANNED.test(l))
  expect(offenders, `${where}: no app copy on a friend surface may say „kolo" or „cyklus"`).toEqual([])
  return copy
}

/**
 * The exclusion's own non-vacuity gate, per surface (FUP-T22): `value` — something a
 * PERSON typed that says a banned word — really is on the page, really is marked
 * `data-user-copy`, and the app-copy sweep really does not see it. Without this, a
 * green sweep could just mean the value never rendered.
 *
 * ⚠ LOWERCASED ON BOTH SIDES: `innerText` honours `text-transform`, so an uppercased
 * caption would make a case-sensitive `not.toContain` pass on a page that renders it.
 */
async function expectExcluded(page, where, value) {
  const needle = value.toLowerCase()
  expect(BANNED.test(value), `${where}: the fixture value is a real offender`).toBe(true)
  const all = (await page.evaluate(collectAllCopy())).toLowerCase()
  expect(all, `${where}: „${value}" really rendered`).toContain(needle)
  const marked = await page.evaluate(collectMarkedData())
  expect(marked.some((m) => m.toLowerCase().includes(needle)),
    `${where}: „${value}" is marked \`data-user-copy\``).toBe(true)
  const app = (await page.evaluate(collectAppCopy())).toLowerCase()
  expect(app, `${where}: the app-copy sweep does not see „${value}"`).not.toContain(needle)
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE REGEX — one home, and it is a UNION of the three spellings that shipped
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T11 · 18 §UC-PI-017 — the ban itself', () => {
  test('⚠ the union catches every inflection, and none of the words this app says on purpose', () => {
    // A ban whose regex matches nothing is the same bug as a sweep over nothing. Both
    // lists are the PROOF of the union; `helpers/vocabulary.js` explains each entry.
    for (const bad of BANNED_CASES.bad) {
      expect(BANNED.test(bad), `the ban catches „${bad}"`).toBe(true)
    }
    for (const good of BANNED_CASES.good) {
      expect(BANNED.test(good), `„${good}" is NOT an offender`).toBe(false)
    }
    // Non-vacuity for the table itself: a table that lost its entries would pass both
    // loops above in silence.
    expect(BANNED_CASES.bad.length, 'the positive table still has its cases').toBeGreaterThanOrEqual(15)
    // …and by IDENTITY, not a count: the full paradigm of „kolo", singular and plural.
    // „kolám", „kolami" and „kôl" were missing from the first cut (PI-T11 review) —
    // a count gate passed without them, which is why this line names every form.
    expect(BANNED_CASES.bad, 'all ten case forms of „kolo" are in the table').toEqual(expect.arrayContaining([
      'kolo', 'kola', 'kolu', 'kole', 'kolom', 'kolá', 'kôl', 'kolám', 'kolách', 'kolami',
    ]))
    expect(BANNED_CASES.good.length, 'the negative table still has its cases').toBeGreaterThanOrEqual(12)
  })

  test('⚠ the three spellings it replaces each had a hole — measured, so nobody restores one', () => {
    // Kept as an executable record of WHY there is one home now. If a future reader
    // "simplifies" `BANNED` back to any of these, the §1 table above reds — and this
    // test says what they will have lost.
    const shipped = /\bkol[oáa]|cykl/iu                  // cycle-stages.spec.js:1434, pre-PI-T11
    const spec17 = /kol[oáa]\b|cykl/i                    // 17 §UC-CS-009
    const spec18 = /cykl|\bkol(o|a|e|u|om|á|ách)\b/i     // 18 §UC-PI-017

    // The shipped one could not see two of the six case forms…
    expect(shipped.test('v tomto kole'), 'shipped missed „kole"').toBe(false)
    expect(shipped.test('k tomuto kolu'), 'shipped missed „kolu"').toBe(false)
    // …and fired on ordinary Slovak that is not the banned word at all.
    expect(shipped.test('kolaps'), 'shipped false-positived „kolaps"').toBe(true)
    expect(BANNED.test('kolaps'), 'the union does not').toBe(false)

    // Both SPEC spellings put the `\b` AFTER an accented letter, where it cannot fire:
    // JavaScript's `\b` is defined on ASCII `\w`, so „kolá" at the end of a string has
    // a non-word character on both sides and no boundary between them.
    expect(spec17.test('dve kolá'), '17 missed „kolá"').toBe(false)
    expect(spec18.test('dve kolá'), '18 missed „kolá"').toBe(false)
    expect(BANNED.test('dve kolá'), 'the union catches it').toBe(true)
    // And 17's would red on module 18's own copy.
    expect(spec17.test('Káva príde okolo 24. 9.'), '17 false-positived „okolo"').toBe(true)
    expect(BANNED.test('Káva príde okolo 24. 9.'), 'the union does not').toBe(false)
  })

  test('the regex is not `/g` — `.test()` gives the same answer twice', () => {
    // A `/g` regex carries `lastIndex` between calls, so the same string alternates
    // true/false. In the `.filter()` sweeps below that would drop every second
    // offender, silently.
    expect(BANNED.test('kolo')).toBe(true)
    expect(BANNED.test('kolo')).toBe(true)
    expect(BANNED.flags).not.toContain('g')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE GUARDED FILE SET — DERIVED from the router, never enumerated
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T11 · 18 §UC-PI-017 — the source guard', () => {
  test.skip(!HAS_SRC, NEEDS_SRC)

  test('⚠ the set is the friend surface\'s import closure, and it is non-vacuous', () => {
    const files = importClosure()
    expect(files, 'the roots are in their own closure').toEqual(expect.arrayContaining(FRIEND_SURFACE_ROOTS))
    expect(files.length, 'a closure this small means the walker stopped walking').toBeGreaterThan(30)
    // Nothing may be UNRESOLVED: a relative import the walker cannot follow is a file
    // the guard silently stopped covering — the exact failure mode a hand list has.
    expect(files.filter((f) => f.startsWith('UNRESOLVED:')), 'every relative import resolves').toEqual([])
    // It really walked THROUGH the views, not just listed them: these arrive only via
    // `FriendPortal → FriendPortalSession → …` and `FriendOrder → …`.
    for (const deep of [
      'views/FriendPortalSession.vue', 'components/neo/NeoDrawer.vue', 'components/CartLineList.vue',
      'lib/portal-state.js', 'lib/cycle-stages.js',
    ]) {
      expect(files, `the walk reached ${deep}`).toContain(deep)
    }
  })

  test('⚠ the DERIVED set is a strict superset of §UC-PI-017\'s hand list', () => {
    // THE POINT OF THIS ROW. The spec states the guard as a `grep` over a list of
    // files; that list has already gone stale twice (three files were missing and were
    // added only in the PI-T4 review). The predicate is a CLASS, so it is computed.
    const files = importClosure()

    // §UC-PI-017's list, verbatim, minus the directory it globs.
    const SPEC_LIST = [
      'views/FriendPortal.vue', 'views/FriendPortalSession.vue', 'views/FriendOrder.vue',
      'components/FriendBalanceCard.vue', 'components/FriendTransactionList.vue',
      'components/PaymentModal.vue', 'components/GuestShareDialog.vue',
      'components/GuestSubOrders.vue', 'components/CartLineList.vue',
      'components/PickupLocationPicker.vue', 'lib/portal-state.js', 'lib/roasters.js',
      'lib/dates.js', 'components/LandingStateModal.vue', 'components/CycleTimeline.vue',
      'lib/cycle-stages.js',
    ]

    // ⚠ ONE FILE ON THE SPEC'S LIST IS NOT A FRIEND SURFACE AT ALL.
    // `PickupLocationPicker.vue` is imported by `views/CycleDetail.vue` and
    // `views/Distribution.vue` — both ADMIN — and by nothing a friend can reach
    // (learnings 06: the admin sets a party's pickup point). Guarding it was harmless
    // but wrong in principle: „cyklus" is allowed on an admin screen. Recorded here
    // rather than silently dropped.
    const ADMIN_ONLY = ['components/PickupLocationPicker.vue']
    expect(files, 'PickupLocationPicker is admin-only — the spec listed it by mistake')
      .not.toContain('components/PickupLocationPicker.vue')

    for (const f of SPEC_LIST) {
      if (ADMIN_ONLY.includes(f)) continue
      expect(files, `${f} is on the spec's list and must stay covered`).toContain(f)
    }

    // …and the derivation covers files the hand list never named. Every one of these
    // renders Slovak copy to a friend and every one landed AFTER the spec was written,
    // which is the argument for computing the set rather than typing it.
    for (const missed of [
      'components/DebtBanner.vue', 'components/PortalExplainer.vue',
      'components/CatScrollArrow.vue', 'components/ProductImageModal.vue',
      'lib/history-badges.js', 'lib/order-lines.js', 'lib/kg.js', 'lib/plural.js',
      'lib/payment-links.js', 'api.js',
    ]) {
      expect(files, `${missed} reaches a friend's screen and the spec's list omits it`).toContain(missed)
    }
    expect(files.filter((f) => !SPEC_LIST.includes(f)).length,
      'the derivation adds a substantial set, not one file').toBeGreaterThanOrEqual(15)
  })

  test('⚠ no file in the derived set says „kolo" or „cyklus" (comments stripped)', () => {
    // GL-T7 (19 §UC-GL-011): the set is the FRIEND closure ∪ the GUEST closure — one
    // guard, one regex, both surfaces. §6 below pins the guest half's own structure.
    const files = importClosure(VOCABULARY_ROOTS)
    expect(files, 'the guest half is really in the swept set').toEqual(expect.arrayContaining([
      ...GUEST_SURFACE_ROOTS, 'components/GuestProductGrid.vue',
    ]))
    const offenders = []
    for (const file of files) {
      for (const [n, line] of bannedLines(file)) offenders.push(`${file}:${n} ${line}`)
    }
    expect(offenders, 'a friend-facing source file carries a banned word').toEqual([])

    // ⚠ NON-VACUITY FOR THE STRIP, and it is load-bearing here more than anywhere:
    // comments ARE stripped (two of these files NAME the banned words in order to ban
    // them, so a raw sweep reds on its own documentation), and a strip that ate a file
    // would make the assertion above pass for the wrong reason. `assertReadable` is
    // `source-pins.js`'s gate: tokens from the region the pins care about, never a
    // length ratio alone — the `//`-before-`/* */` ordering trap once swallowed 16 709
    // characters of `FriendPortalSession.vue` and turned a source pin green.
    assertReadable('views/FriendPortalSession.vue', ['Zostatok a platby', 'portal-landing'])
    // GP-T7 (PO decision (2) 2026-09-24): ~~'uzamknutia objednávok'~~ → the „uzavreté" register.
    assertReadable('views/FriendOrder.vue', ['Späť na ponuku', 'uzavretia objednávok'])
    assertReadable('lib/cycle-stages.js', ['Objednávky otvorené', 'Zabalené, rozvážame'])
    assertReadable('components/GuestProductGrid.vue', ['emptyMessage', 'product-'])
    expect(files.length, 'and the sweep really visited every one of them').toBe(importClosure(VOCABULARY_ROOTS).length)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE SERVER — the 4xx messages a FRIEND reads (§UC-PI-017 „Not covered" → swept)
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠ AUDIENCE-SCOPED, exactly like `sanitizeFriend`'s field rules. The same 404 text
// survives on the ADMIN-guarded routes of the same files (`orders.js`'s pickup PATCH,
// `guest-links.js`'s three `requireAdmin` routes, `vouchers.js`'s two, `products.js`'s
// duplicate-in-cycle 409, all of `cycles.js`) — „cyklus" is the admin's word. So a
// grep for „Cyklus nebol" still finds hits, and that is the rule working.
test.describe('PI-T11 · 18 §UC-PI-017 — friend-facing server messages', () => {
  test('the order routes\' 404 is the one a friend actually sees, and it is clean', async () => {
    const friend = await makeFriend('Srv404')
    // `validateCyclePassword` — the 404 of the deep link's own GET, the cart PUT and
    // the submit. `FriendOrder.vue` paints it verbatim in its fatal-error banner.
    const res = await ctx.get(`/api/orders/cycle/999777/friend/${friend.id}`, {
      headers: { Authorization: `Bearer ${friend.token}` }, timeout: TIMEOUT,
    })
    expect(res.status(), 'status code unchanged').toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Ponuka nebola nájdená')
    expect(BANNED.test(body.error), 'and it says neither banned word').toBe(false)

    // The cart PUT shares the helper, so it shares the message — pinned, because a
    // future edit that gives one route its own string would silently split the copy.
    const put = await friendCall(friend, `/api/orders/cycle/999777/friend/${friend.id}`, { items: [] })
    expect(put.status()).toBe(404)
    expect((await put.json()).error).toBe('Ponuka nebola nájdená')
  })

  test('the host\'s share-link routes answer the same clean 404', async () => {
    const friend = await makeFriend('SrvLink')
    for (const [method, path] of [
      ['get', `/api/guest-links/cycle/999778`],
      ['post', `/api/guest-links/cycle/999778`],
    ]) {
      const res = await ctx[method](path, {
        headers: { Authorization: `Bearer ${friend.token}` }, data: {}, timeout: TIMEOUT,
      })
      expect(res.status(), `${method} ${path} status unchanged`).toBe(404)
      expect((await res.json()).error, `${method} ${path}`).toBe('Ponuka nebola nájdená')
    }
  })

  test('the Packeta 400 on submit keeps its status and drops „cyklus"', async () => {
    const friend = await makeFriend('SrvPacketa')
    const cycle = await makeCycle(`PI11 Packeta ${uniq}`)
    const product = await addProduct(cycle.id, { name: `PI11 Packeta Bean ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
      items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
    })).status(), 'cart saved').toBe(200)

    // `parcel_enabled` is 0 on a fresh cycle, so asking for Packeta is the 400.
    const res = await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, {
      use_parcel_delivery: true, packeta_address: 'Z-BOX Hlavná 1',
    }, 'post')
    expect(res.status(), 'status code unchanged').toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Doručenie Packetou nie je pre túto objednávku dostupné')
    expect(BANNED.test(body.error)).toBe(false)
  })

  test('⚠ the voucher ledger NOTE is app copy too, and it renders on „Zostatok a platby"', async ({ page }) => {
    // Not a 4xx — a string the server WRITES into `transactions.note`, which
    // `FriendTransactionList.vue` paints on the balance view. Nothing pinned it before
    // this row. Rows written earlier keep their old text (a note is a stored value),
    // which is why the rendered sweep treats the meta line as DATA.
    const friend = await makeFriend('Voucher')
    // Poisoned like §4's cycle names (the file's own idiom): the note EMBEDS this
    // name, so a real offender is what makes the `/zostatok` exclusion below
    // non-vacuous (`expectExcluded` requires it — an unpoisoned name would just
    // prove the sweep never saw a banned word, not that it excludes one on purpose).
    const cycle = await makeCycle(`PI11 Voucher kolo cyklus ${uniq}`)
    const product = await addProduct(cycle.id, { name: `PI11 Voucher Bean ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
      items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
    })).status()).toBe(200)
    expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, {
      pickup_location_note: `Pri fontáne ${uniq}`,
    }, 'post')).status()).toBe(200)

    const gen = await admin('/api/vouchers/generate', {
      method: 'post',
      data: { source_cycle_id: cycle.id, friend_ids: [friend.id], supplier_discount: 30, applied_discount: 10 },
    })
    expect(gen.status(), 'voucher generated').toBe(201)
    expect((await gen.json()).count, 'one voucher for one submitted order').toBe(1)

    const pending = await ctx.get('/api/vouchers/pending', {
      headers: { Authorization: `Bearer ${friend.token}` }, timeout: TIMEOUT,
    })
    expect(pending.status()).toBe(200)
    const [voucher] = await pending.json()
    expect(voucher, 'the friend has the pending voucher').toBeTruthy()

    const resolved = await ctx.post(`/api/vouchers/${voucher.id}/resolve`, {
      headers: { Authorization: `Bearer ${friend.token}` }, data: { action: 'accept' }, timeout: TIMEOUT,
    })
    expect(resolved.status(), 'accepted').toBe(200)

    const txs = await ctx.get(`/api/transactions/friend/${friend.id}`, {
      headers: { Authorization: `Bearer ${friend.token}` }, timeout: TIMEOUT,
    })
    expect(txs.status()).toBe(200)
    const note = (await txs.json()).find((t) => t.type === 'adjustment')?.note || ''
    expect(note, 'the composed note').toBe(`Voucher za objednávku ${cycle.name}`)
    // The CYCLE NAME half is data and may say anything; the APP half may not.
    expect(BANNED.test(note.replace(cycle.name, '')), 'the app half of the note is clean').toBe(false)

    // ⚠ THE TITLE'S OWN CLAIM, UNPROVEN UNTIL NOW: the note above is what the SERVER
    // wrote, not what the friend actually sees. `FriendTransactionList.vue` reads
    // `tx.cycle_name || tx.note`, and the voucher INSERT sets no `cycle_name` column
    // (`routes/vouchers.js`), so the row renders `tx.note` verbatim on `/zostatok`.
    await signIn(page, friend)
    await open(page, '/zostatok')
    const row = page.getByTestId('tx-row').filter({ hasText: 'Voucher' })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('tx-meta')).toContainText(note)
    // The row's `data-user-copy` marker is what keeps this note OUT of the app-copy
    // sweep (§4's exclusion), proven the FUP-T22 way: really on the page, really
    // marked, really invisible to `collectAppCopy()`.
    await expectExcluded(page, 'the voucher transaction note on /zostatok', note)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE RENDERED SWEEP — every view, state and modal of module 18
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T11 · 18 §UC-PI-017 — the DOM sweep', () => {
  test('the OPEN landing, the drawer, the profile modal and the invite modal', async ({ page }) => {
    const friend = await makeFriend('Open')
    const cycle = await makeCycle(`PI11 Open ${uniq}`)
    const product = await addProduct(cycle.id, {
      name: `PI11 Open Bean ${uniq}`, purpose: 'Espresso', price_250g: 7.5,
    })

    await signIn(page, friend)
    await open(page)
    await expect(page.getByTestId('product-card').filter({ hasText: product.name })).toBeVisible()
    await expectCleanCopy(page, 'the open landing', ['Podpultovka', 'Aktuálna ponuka', 'Pozvať'])

    // The drawer is a `role="dialog"` mounted with `v-if`, so its copy is only on the
    // page while it is open (§UC-PI-004).
    await openMenu(page)
    await expectCleanCopy(page, 'the drawer', ['Moje objednávky', 'Zostatok a platby', 'Odhlásiť sa'])
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    await openProfile(page)
    await expectCleanCopy(page, 'the profile modal', ['Upraviť profil'])
    await page.keyboard.press('Escape')

    await openInvite(page)
    await expectCleanCopy(page, 'the invite modal', ['Pozvi priateľa'])
  })

  test('⚠ the poisoned OPEN round: drawer history line, share dialog, Kolegovia sub-orders (PI-T11 review)',
    async ({ page }) => {
      // Three renders the first cut left unmarked, each carrying person-typed text on a
      // surface the sweep reads: the drawer's „Moje objednávky" sub-line (it composed
      // the cycle name INTO one string), the share dialog's cycle-name subtitle, and a
      // colleague's `guest_name` on the Kolegovia tab.
      const friend = await makeFriend('OpenPoison')
      const cycle = await makeCycle(`PI11 Open kolo cyklus ${uniq}`)
      const product = await addProduct(cycle.id, {
        name: `PI11 OpenPoison Bean ${uniq}`, purpose: 'Espresso', price_250g: 7,
      })
      expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
        items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
      })).status(), 'cart saved').toBe(200)
      expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, {
        pickup_location_note: `Pri fontáne ${uniq}`,
      }, 'post')).status(), 'order submitted').toBe(200)

      const link = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, {
        headers: { Authorization: `Bearer ${friend.token}` }, timeout: TIMEOUT,
      })
      expect([200, 201], 'share link').toContain(link.status())
      const linkToken = (await link.json()).link.token
      const guestName = `Hosť kolo cyklus ${uniq}`
      const guest = await ctx.post(`/api/guest/${linkToken}/orders`, {
        data: {
          guest_name: guestName, guest_phone: '0905 012 998',
          items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
        },
        timeout: TIMEOUT,
      })
      expect(guest.status(), 'guest sub-order').toBe(201)

      await signIn(page, friend)
      await open(page)
      await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'open')
      await expectCleanCopy(page, 'the poisoned open landing', ['Aktuálna ponuka', 'Pozvať'])

      // The drawer's history row: „1 objednávku · naposledy {name}" — the app half
      // swept, the name excluded, and the ONE render still reads as one line.
      await openMenu(page)
      const historySub = drawer(page).locator('[data-menu-item="history"] .sub')
      await expect(historySub).toHaveText(`1 objednávku · naposledy ${cycle.name}`)
      await expectCleanCopy(page, 'the drawer with a poisoned history line',
        ['Moje objednávky', '1 objednávku · naposledy'])
      await expectExcluded(page, 'the drawer history line', cycle.name)

      // „Zdieľať s kolegami" opens the ONE GuestShareDialog (on an open round, as here,
      // with its per-cycle section; GL-T6c added the standing-only locked/closed case).
      await drawer(page).locator('[data-menu-item="share"]').click()
      await expect(page.getByRole('dialog', { name: 'Zdieľať s kolegami' })).toBeVisible()
      await expectCleanCopy(page, 'the share dialog', ['Zdieľať s kolegami', 'Kolegovia si objednajú'])
      await expectExcluded(page, 'the share dialog subtitle', cycle.name)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Zdieľať s kolegami' })).toHaveCount(0)

      // The Kolegovia tab: the colleague's own name is theirs, the panel's copy is ours.
      await page.getByTestId('main-tab-guests').click()
      await expect(page.getByTestId('guest-sub-orders')).toContainText(guestName)
      await expectCleanCopy(page, 'the Kolegovia tab', ['Objednávky kolegov', 'Kolegovia platia priamo správcovi'])
      await expectExcluded(page, 'the Kolegovia sub-order card', guestName)
    })

  test('⚠ the pickup modal: a location\'s name and address are data, „Iné" is app copy (PI-T11 review)',
    async ({ page }) => {
      const friend = await makeFriend('Pickup')
      const cycle = await makeCycle(`PI11 Pickup ${uniq}`)
      const product = await addProduct(cycle.id, {
        name: `PI11 Pickup Bean ${uniq}`, purpose: 'Espresso', price_250g: 7,
      })
      expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
        items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
      })).status(), 'cart saved').toBe(200)

      // STUBBED, never created: a real location is GLOBAL and would put a poisoned
      // name on every later spec's pickup list. The stub is scoped to this page.
      const locName = `Bod kolo ${uniq}`
      const locAddress = `Cyklistická 1, ${uniq}`
      await page.route('**/api/pickup-locations*', (route) => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{ id: 990001, name: locName, address: locAddress, active: 1, for_coffee: 1, for_bakery: 1 }]),
      }))

      await signIn(page, friend)
      await gotoCycle(page, cycle.id)
      await page.locator('.cartbar').getByRole('button', { name: 'Odoslať' }).click()
      const modal = page.getByRole('dialog', { name: 'Spôsob prevzatia' })
      await expect(modal).toBeVisible()
      await expect(modal).toContainText(locName)
      await expectCleanCopy(page, 'the pickup modal', ['Spôsob prevzatia', 'Iné', 'Potvrdiť a odoslať'])
      await expectExcluded(page, 'the pickup location name', locName)
      await expectExcluded(page, 'the pickup location address', locAddress)
    })

  test('⚠ a planned round\'s `plan_note` is data in the state modal AND the warn banner (PI-T11 review)',
    async ({ page }) => {
      // 17's `nextOpeningText()` branch 2 returns the admin's note VERBATIM, and both
      // the closed state modal's card and the warn banner print it. Only that branch
      // is marked (`lib/portal-state.js nextTextIsNote()`); the other two are app copy.
      const friend = await makeFriend('Note')
      const note = `Ďalšie kolo cyklu ${uniq}`
      await stubCycles(page, [
        cycleRow({ n: 4, status: 'completed', created_at: '2026-08-01 10:00:00' }),
        cycleRow({ n: 5, status: 'planned', opens_at: null, plan_note: note, created_at: '2026-09-01 10:00:00' }),
      ])
      await signIn(page, friend)
      await open(page)

      await expect(landingStateModal(page)).toBeVisible()
      await expect(page.getByTestId('next-round-text')).toHaveText(note)
      await expectCleanCopy(page, 'the closed state modal carrying a poisoned note', ['Objednávky sú zatvorené'])
      await expectExcluded(page, 'the state modal card', note)

      await dismissLandingState(page)
      await expectCleanCopy(page, 'the closed warn banner carrying a poisoned note', ['Objednávky sú zatvorené.'])
      await expectExcluded(page, 'the closed warn banner', note)
    })

  test('⚠ the LOCKED landing, no own order: a poisoned `plan_note` in the modal AND `landing-locked-banner` (PI-T11 review r2)',
    async ({ page }) => {
      const friend = await makeFriend('LockedNote')
      const note = `Ďalšie kolo cyklu (zamknuté) ${uniq}`
      await stubCycles(page, [
        cycleRow({ n: 6, status: 'locked', created_at: '2026-09-02 10:00:00' }),
        cycleRow({ n: 7, status: 'planned', opens_at: null, plan_note: note, created_at: '2026-09-03 10:00:00' }),
      ])
      await signIn(page, friend)
      await open(page)
      await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'locked')

      await expect(landingStateModal(page)).toBeVisible()
      await expect(page.getByTestId('next-round-text')).toHaveText(note)
      await expectExcluded(page, 'the locked state modal card', note)

      await dismissLandingState(page)
      const banner = page.getByTestId('landing-locked-banner')
      await expect(banner).toContainText(note)
      await expectCleanCopy(page, 'the locked warn banner carrying a poisoned note', ['Objednávky sú uzavreté.'])
      await expectExcluded(page, 'the locked warn banner', note)
    })

  test('⚠ the LOCKED landing with an own order: the pickup badge and `landing-next-round` carry typed text (PI-T11 review r2)',
    async ({ page }) => {
      // The own-order card's pickup badge prints a note / location name / Packeta
      // address the PERSON typed (`FriendOrder.orderPickupText` → `{ text, data }`),
      // and the next-round banner prints the admin's `plan_note` verbatim.
      const friend = await makeFriend('OwnPickup')
      const cycle = await makeCycle(`PI11 OwnPickup ${uniq}`)
      const product = await addProduct(cycle.id, {
        name: `PI11 OwnPickup Bean ${uniq}`, purpose: 'Espresso', price_250g: 8, stock_limit_g: 5000,
      })
      const pickupNote = `pri kole ${uniq}`
      expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
        items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
      })).status()).toBe(200)
      expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, {
        pickup_location_note: pickupNote,
      }, 'post')).status(), 'order submitted with a poisoned note').toBe(200)
      expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)

      const planNote = `Ďalšie kolo cyklu (s objednávkou) ${uniq}`
      await stubCycles(page, [
        lockedRow(cycle, { hasOrder: true, orderStatus: 'submitted', orderTotal: 8 }),
        cycleRow({ n: 8, status: 'planned', opens_at: null, plan_note: planNote, created_at: '2026-09-11 10:00:00' }),
      ])
      await signIn(page, friend)
      await open(page)
      await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'locked')

      const badge = page.getByTestId('own-order-pickup')
      await expect(badge).toHaveText(pickupNote)
      await expect(page.getByTestId('landing-next-round')).toContainText(planNote)
      await expectCleanCopy(page, 'the locked own-order landing with typed pickup + note',
        ['Vaša objednávka', 'Ďalšia objednávka', 'ponuku si už môžete prezrieť nižšie'])
      await expectExcluded(page, 'the own-order pickup badge', pickupNote)
      await expectExcluded(page, 'the next-round banner', planNote)
    })

  test('⚠ „Ako to funguje": a pickup location\'s name and address never reach the page (PI-T11 r2, PO copy 2026-09-29)', async ({ page }) => {
    const friend = await makeFriend('ExplPickup')
    const locName = `Stanovisko kolo ${uniq}`
    const locAddress = `Cyklistická 7, ${uniq}`
    await page.route('**/api/pickup-locations*', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([
        { id: 990002, name: locName, address: locAddress, active: 1, for_coffee: 1, for_bakery: 1 },
        { id: 990003, name: 'Fontána', address: null, active: 1, for_coffee: 1, for_bakery: 1 },
      ]),
    }))
    await signIn(page, friend)
    await open(page, '/ako-to-funguje')
    // ~~The row renders each location in a `data-user-copy` span~~ — SUPERSEDED by the
    // PO copy pass 2026-09-29: the row is a static sentence, so the poisoned names in
    // the feed above must not reach the page at all, and the whole page is app copy.
    await expect(page.getByTestId('explainer-pickup-line')).toContainText('môžem ti kávu doniesť cestou')
    await expectCleanCopy(page, '/ako-to-funguje with typed locations', ['môžem ti kávu doniesť cestou', 'Odberné miesto v Bratislave'])
    await expect(page.getByTestId('portal-explainer')).not.toContainText(locName)
    await expect(page.getByTestId('portal-explainer')).not.toContainText(locAddress)
  })

  test('the CLOSED landing — its state modal and the warn banner behind it', async ({ page }) => {
    const friend = await makeFriend('Closed')
    // `closed` = no open and no locked cycle; a planned one supplies the next-round
    // sentence, which is module 17's composed copy and the most likely place for a
    // banned word to come back (the prototype said „ĎALŠIE KOLO").
    await stubCycles(page, [
      cycleRow({ n: 1, status: 'completed', created_at: '2026-08-01 10:00:00' }),
      cycleRow({ n: 2, status: 'planned', opens_at: '2026-12-01', created_at: '2026-09-01 10:00:00' }),
    ])
    await signIn(page, friend)
    await open(page)

    await expect(landingStateModal(page)).toBeVisible()
    await expectCleanCopy(page, 'the closed landing + state modal',
      ['Objednávky sú zatvorené', 'Prezrieť ponuku'])

    await dismissLandingState(page)
    await expectCleanCopy(page, 'the closed landing, modal dismissed', ['Objednávky sú zatvorené'])
  })

  test('the LOCKED landing with no own order — the second state modal', async ({ page }) => {
    const friend = await makeFriend('LockedNo')
    await stubCycles(page, [
      cycleRow({ n: 3, status: 'locked', created_at: '2026-09-02 10:00:00' }),
    ])
    await signIn(page, friend)
    await open(page)
    await expect(landingStateModal(page)).toBeVisible()
    await expectCleanCopy(page, 'the locked landing (no own order)',
      ['Objednávky sú uzavreté', 'Prezrieť ponuku'])
  })

  test('⚠ the poisoned round: every screen that renders a cycle NAME, and the exclusion that makes it pass',
    async ({ page }) => {
      // THE FUP-T22 PROOF. The round is named „PI11 kolo cyklus …" — an admin may type
      // anything, and this suite's own fixtures already create cycles called „… cyklus".
      // Every screen below paints that name. The sweep must stay green, and §4.5 below
      // proves the name really was on the page rather than the test having missed it.
      const friend = await makeFriend('Poison')
      const cycle = await makeCycle(POISON)
      const product = await addProduct(cycle.id, {
        name: `PI11 Poison Bean ${uniq}`, purpose: 'Espresso', price_250g: 9, stock_limit_g: 5000,
      })
      expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
        items: [{ product_id: product.id, variant: '250g', quantity: 2 }],
      })).status(), 'cart saved').toBe(200)
      expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, {
        pickup_location_note: `Pri fontáne ${uniq}`,
      }, 'post')).status(), 'order submitted').toBe(200)
      // A pending voucher so the VOUCHER MODAL opens on the portal — §UC-PI-017's copy
      // table edits that modal, and it renders the cycle name too.
      expect((await admin('/api/vouchers/generate', {
        method: 'post',
        data: { source_cycle_id: cycle.id, friend_ids: [friend.id], supplier_discount: 25, applied_discount: 5 },
      })).status(), 'voucher generated').toBe(201)
      expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status(),
        'cycle locked').toBe(200)

      await stubCycles(page, [lockedRow(cycle, { hasOrder: true, orderStatus: 'submitted', orderTotal: 18 })])
      await signIn(page, friend)
      await open(page)

      // The voucher modal opens by itself on the portal (03 UC-FL-001, untouched).
      const voucherModal = page.getByText('Máš voucher!')
      await expect(voucherModal).toBeVisible()
      await expectCleanCopy(page, 'the voucher modal',
        ['Máš voucher!', 'Za tvoju objednávku (', 'ti patrí zľavový voucher'])
      // Decline it — the modal's own control, and the branch that writes no ledger row
      // — so the landing underneath can be swept next.
      await page.getByRole('button', { name: 'Nepotrebujem' }).click()
      await expect(voucherModal).toHaveCount(0)

      await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'locked')
      await expectCleanCopy(page, 'the locked landing carrying the poisoned name',
        ['Vaša objednávka', 'Kde je vaša káva', 'Ponuka ·'])

      // The same name, on the deep link's appbar title.
      await gotoCycle(page, cycle.id)
      await expect(page.locator('.appbar .titles .t')).toHaveText(cycle.name)
      await expectCleanCopy(page, 'the deep link carrying the poisoned name',
        ['Objednávky sú uzavreté.'])
    })

  test('the LOCKED landing with an own order, „Moje objednávky", „Zostatok a platby" and the explainer',
    async ({ page }) => {
      const friend = await makeFriend('Views')
      const cycle = await makeCycle(POISON.replace('PI11', 'PI11b'))
      const product = await addProduct(cycle.id, {
        name: `PI11 Views Bean ${uniq}`, purpose: 'Espresso', price_250g: 8, stock_limit_g: 5000,
      })
      expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
        items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
      })).status()).toBe(200)
      expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, {
        pickup_location_note: `Pri fontáne ${uniq}`,
      }, 'post')).status()).toBe(200)
      expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)

      await stubCycles(page, [lockedRow(cycle, { hasOrder: true, orderStatus: 'submitted', orderTotal: 8 })])
      await signIn(page, friend)
      await open(page)
      await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'locked')
      await expectCleanCopy(page, 'the locked landing (own order)',
        ['Vaša objednávka', 'Kde je vaša káva'])

      await open(page, '/moje-objednavky')
      await expect(page.getByTestId('history-round').first()).toBeVisible()
      await expectCleanCopy(page, '/moje-objednavky', ['Moje objednávky'])
      // …and the expanded body, which renders the ordered lines.
      await page.getByTestId('history-round').first().click()
      await expectCleanCopy(page, '/moje-objednavky, expanded', ['Moje objednávky'])

      await open(page, '/zostatok')
      await expectCleanCopy(page, '/zostatok', ['Zostatok a platby'])

      await open(page, '/ako-to-funguje')
      await expectCleanCopy(page, '/ako-to-funguje',
        ['Ako to funguje', 'Podpultovka je spoločná objednávka'])
    })

  test('⚠ §4\'s exclusion is not vacuous: the poisoned name IS on the page and IS excluded',
    async ({ page }) => {
      // Without this, every green sweep above could mean „the cycle name never
      // rendered" — which is how an exclusion silently becomes a hole.
      const friend = await makeFriend('Excl')
      const cycle = await makeCycle(POISON.replace('PI11', 'PI11c'))
      await addProduct(cycle.id, { name: `PI11 Excl Bean ${uniq}`, purpose: 'Espresso', price_250g: 6 })
      expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)

      await stubCycles(page, [lockedRow(cycle)])
      await signIn(page, friend)
      await open(page)

      // ⚠ LOWERCASED ON BOTH SIDES. The caption is `.field-lbl`, which is
      // `text-transform:uppercase`, and `innerText` HONOURS that — so the name arrives
      // as „PONUKA · PI11C KOLO CYKLUS …". A case-sensitive `not.toContain` here would
      // pass on a page that renders the name in full, which is precisely the vacuous
      // assertion this test exists to prevent.
      const name = cycle.name.toLowerCase()
      const all = (await page.evaluate(collectAllCopy())).toLowerCase()
      expect(all, 'the poisoned cycle name really rendered').toContain(name)
      expect(BANNED.test(all), 'and it really is an offender by this regex').toBe(true)

      const marked = await page.evaluate(collectMarkedData())
      expect(marked.some((t) => t.toLowerCase().includes(name)),
        'the view marks it as person-typed with `data-user-copy`').toBe(true)

      const app = await page.evaluate(collectAppCopy())
      expect(app.toLowerCase(), 'and the app-copy sweep does not see it').not.toContain(name)
      expect(app.length, 'while still reading the rest of the screen').toBeGreaterThan(200)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. §UC-PI-018 — `/cycle/:id` keeps working: the standalone screen
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠ NAVIGATION GOES THROUGH `helpers/portal.js gotoCycle()`. A cold
// `page.goto('/cycle/:id')` BOUNCES to `/`: the Bearer token lives in memory and
// `FriendPortal.vue` is its only restorer. `gotoCycle` uses that bounce and goes back.
test.describe('PI-T11 · 18 §UC-PI-018 — the deep link', () => {
  test('the standalone chrome: own `.app` root, cycle-name title, friend subtitle, chip, ticker',
    async ({ page }) => {
      const friend = await makeFriend('Deep')
      const cycle = await makeCycle(`PI11 Deep ${uniq}`)
      const product = await addProduct(cycle.id, {
        name: `PI11 Deep Bean ${uniq}`, purpose: 'Espresso', price_250g: 7,
      })

      await signIn(page, friend)
      await gotoCycle(page, cycle.id)

      // `mode='route'` renders its OWN `.app` root — the landing's mount does not
      // (§UC-PI-005), and the two must not converge.
      const root = page.locator('[data-fo-mode="route"]')
      await expect(root).toHaveClass(/\bapp\b/)
      await expect(page.locator('.appbar')).toHaveCount(1)
      await expect(page.locator('.appbar .titles .t')).toHaveText(cycle.name)
      await expect(page.locator('.appbar .titles .s')).toHaveText(friend.name)
      await expect(page.locator('.ticker')).toContainText('OBJEDNÁVKY OTVORENÉ')
      await expect(page.locator('.appbar .chip.acc')).toHaveText('Otvorené')
      await expect(page.getByTestId('product-card').filter({ hasText: product.name })).toBeVisible()

      // ⚠ The chevron's accessible name stays exactly „Späť" — the fatal-error button
      // („Späť na ponuku") CONTAINS it, and Playwright matches a role name as a
      // case-insensitive SUBSTRING unless `exact: true` (learnings 03).
      const chevron = page.getByRole('button', { name: 'Späť', exact: true })
      await expect(chevron).toHaveCount(1)
      await expect(page.locator('.appbar [aria-label="Späť"]')).toHaveCount(1)
      await chevron.click()
      await expect(page).toHaveURL(/\/$/)
      await expectLanding(page)
    })

  test('⚠ `/cycle/<open id>` renders the same grid as the landing, and `/` is not a redirect to it',
    async ({ page }) => {
      const friend = await makeFriend('Same')
      const cycle = await makeCycle(`PI11 Same ${uniq}`)
      const product = await addProduct(cycle.id, {
        name: `PI11 Same Bean ${uniq}`, purpose: 'Espresso', price_250g: 5.5,
      })

      await signIn(page, friend)
      await open(page)
      // Two routes, ONE component, ONE behaviour (§UC-PI-018).
      expect(new URL(page.url()).pathname, 'the landing stays on `/`').toBe('/')
      await expect(page.getByTestId('product-card').filter({ hasText: product.name })).toBeVisible()
      const landingCards = await page.getByTestId('product-card').count()

      await gotoCycle(page, cycle.id)
      await expect(page.getByTestId('product-card').filter({ hasText: product.name })).toBeVisible()
      expect(await page.getByTestId('product-card').count(), 'the same grid').toBe(landingCards)
      // …but with the chrome the landing does not have.
      await expect(page.locator('.appbar .titles .t')).toHaveText(cycle.name)

      await expectCleanCopy(page, 'the deep link, open', ['Moja objednávka', 'Kolegovia'])
    })

  test('a COMPLETED round\'s deep link is read-only, with the lock chip and the locked banner',
    async ({ page }) => {
      const friend = await makeFriend('Done')
      const cycle = await makeCycle(`PI11 Done ${uniq}`)
      const product = await addProduct(cycle.id, {
        name: `PI11 Done Bean ${uniq}`, purpose: 'Espresso', price_250g: 6.5,
      })
      expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'completed' } })).status(),
        'cycle completed').toBe(200)

      await signIn(page, friend)
      await gotoCycle(page, cycle.id)

      // 04 §UC-FO-014 treats `completed` like `locked`.
      await expect(page.locator('.appbar .chip[title="Objednávky sú uzavreté"]')).toHaveCount(1)
      await expect(page.locator('.appbar .chip.acc')).toHaveCount(0)
      await expect(page.locator('.app .banner.warn')).toContainText('Objednávky sú uzavreté.')
      await expect(page.getByTestId('product-card').filter({ hasText: product.name })
        .getByRole('button', { name: 'viac' }).first()).toBeDisabled()

      await expectCleanCopy(page, 'the deep link, completed',
        ['Objednávky sú uzavreté.', 'Už nie je možné meniť objednávku.'])
    })

  test('the fatal-error state on an unknown id: the server\'s clean 404 and „Späť na ponuku" → `/`',
    async ({ page }) => {
      const friend = await makeFriend('Ghost')
      const cycle = await makeCycle(`PI11 Ghost ${uniq}`)
      await addProduct(cycle.id, { name: `PI11 Ghost Bean ${uniq}`, purpose: 'Espresso', price_250g: 5 })

      // ⚠ THE SERVER'S OWN BODY, fetched here and replayed into the page. A cold
      // `goto('/cycle/999779')` cannot be used (it bounces — the token is in memory),
      // and a hand-written stub would pin the test's idea of the message rather than
      // the route's. So the real 404 is fetched over the API and served for the load.
      const real404 = await ctx.get(`/api/orders/cycle/999779/friend/${friend.id}`, {
        headers: { Authorization: `Bearer ${friend.token}` }, timeout: TIMEOUT,
      })
      expect(real404.status(), 'the route really 404s on an unknown round').toBe(404)
      const body = await real404.text()
      await page.route('**/api/orders/cycle/*/friend/*', (route) => route.fulfill({
        status: 404, contentType: 'application/json', body,
      }))

      await signIn(page, friend)
      await gotoCycle(page, cycle.id)

      const banner = page.locator('.banner.danger')
      await expect(banner).toBeVisible()
      // ⚠ THE SERVER'S MESSAGE, RENDERED. This is the one screen where §3's 404 copy
      // becomes friend-facing pixels, so the two halves of this row meet here.
      await expect(banner).toContainText('Ponuka nebola nájdená')
      await expectCleanCopy(page, 'the fatal-error state', ['Chyba:', 'Späť na ponuku'])

      const back = page.getByRole('button', { name: 'Späť na ponuku' })
      await expect(back).toBeVisible()
      await back.click()
      await expect(page).toHaveURL(/\/$/)
      await expectLanding(page)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE GUEST SURFACE — GL-T7, 19 §UC-GL-011 (module-19 closeout)
// ═════════════════════════════════════════════════════════════════════════════
//
// PI-T11 left the guest pages out of the guard on purpose (two „cyklus" strings there
// were waiting for a PO decision); 18 §UC-PI-017's rule — „objednávka", never
// „cyklus"/„kolo" — IS the PO's rule, so GL-T7 applies it and widens the guard.
//
// ⚠ AUDIENCE, exactly like §3: `POST /api/guest-orders/:id/cancel` is `requireAdmin`
// (only `CycleDetail.vue` calls it) and KEEPS „Cyklus" — the admin's word. That half is
// PINNED below, so the decision cannot drift either way without a red.
//
// Every new string is a PO DRAFT (learnings 11 §GL-T7). Status codes and `reason`
// values are byte-identical to what shipped.
const GUEST_COPY = Object.freeze({
  /** `routes/guest.js CLOSED` — the submit 409 (preopen on submit, both token spaces). */
  closed: 'Objednávky sú už uzavreté, objednávku už nie je možné odoslať.',
  /**
   * `PUT /api/guest/o/:orderToken` on a non-open round. Deliberately NOT the read-only
   * notice's sentence („…objednávku už nie je možné upraviť."): after the 409 the page
   * reloads and shows BOTH banners stacked, so the server half says what failed — the
   * save — worded like its lost-race twin („Objednávky boli práve uzavreté, zmenu…").
   */
  editClosed: 'Objednávky sú už uzavreté, zmenu už nie je možné uložiť.',
  /** Host `DELETE /api/guest-orders/:id` on a non-open round (renders in `GuestSubOrders`). */
  hostDeleteClosed: 'Objednávky sú už uzavreté, objednávku kolegu už nie je možné odstrániť.',
  /** `GuestProductGrid.vue` `emptyMessage` default. */
  empty: 'V ponuke zatiaľ nie sú žiadne produkty.',
})
/** Admin-only — deliberately unchanged (the audience rule). */
const ADMIN_CANCEL_CLOSED = 'Cyklus je už uzavretý, objednávku kolegu už nie je možné zrušiť.'

const BACKEND_SRC = resolve(FRONTEND_SRC, '../../backend/src')
const readBackend = (rel) => readFileSync(join(BACKEND_SRC, rel), 'utf8')

/**
 * A backend router split into its route handlers: `{ header, body, admin }` per
 * `router.<verb>(…)` registration, plus the shared preamble. `admin` = the
 * registration line itself names `requireAdmin` (the MIXED-mount rule: gate per route).
 */
function routeBlocks(rel) {
  const lines = stripComments(readBackend(rel)).split('\n')
  const starts = lines.flatMap((l, i) => (/^router\.(get|post|put|patch|delete)\(/.test(l) ? [i] : []))
  const blocks = [{ header: '(preamble)', body: lines.slice(0, starts[0]).join('\n'), admin: false }]
  starts.forEach((start, n) => {
    blocks.push({
      header: lines[start].trim(),
      body: lines.slice(start, starts[n + 1] ?? lines.length).join('\n'),
      admin: lines[start].includes('requireAdmin'),
    })
  })
  return blocks
}

/**
 * Every route REGISTRATION in the RAW file, at any indentation and any verb (incl.
 * `route`/`use`). `routeBlocks()` only splits on column-0 `router.<verb>(`; this count
 * proves no registration escaped that split (review, GL-T7).
 */
const rawRegistrations = (rel) =>
  (readBackend(rel).match(/^\s*router\.(get|post|put|patch|delete|route|use)\(/gm) || []).length

/**
 * Every raw `error:` / `message:` string literal, as written in the file (comments
 * included — a literal the strip ate would show up here as missing).
 */
const rawMessageLiterals = (rel) =>
  [...readBackend(rel).matchAll(/(?:error|message):\s*(['`"])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((m) => m[0])

const offendingLines = (text) => text.split('\n').map((l) => l.trim()).filter((l) => BANNED.test(l))

test.describe('GL-T7 · 19 §UC-GL-011 — the guest source guard', () => {
  test.skip(!HAS_SRC, NEEDS_SRC)

  test('⚠ the guest roots ARE the router\'s `/g/…` components — a new guest route cannot escape the guard', () => {
    const router = stripComments(readFileSync(join(FRONTEND_SRC, 'router.js'), 'utf8'))
    const routes = [...router.matchAll(/path:\s*'(\/g\/[^']*)'[\s\S]*?import\(\s*'\.\/([^']+)'\s*\)/g)]
      .map(([, path, file]) => ({ path, file }))
    expect(routes.map((r) => r.path), 'non-vacuity: the three shipped guest routes were parsed')
      .toEqual(['/g/:token', '/g/o/:orderToken', '/g/:token/o/:orderToken'])
    expect([...new Set(routes.map((r) => r.file))].sort()).toEqual([...GUEST_SURFACE_ROOTS].sort())
  })

  test('the guest closure walks THROUGH the views and resolves every import', () => {
    const files = importClosure(GUEST_SURFACE_ROOTS)
    expect(files.filter((f) => f.startsWith('UNRESOLVED:')), 'every relative import resolves').toEqual([])
    for (const deep of [
      'components/GuestProductGrid.vue', 'components/GuestSteps.vue', 'components/GuestRoastersLine.vue',
      'components/GuestBrandHeader.vue', 'components/GuestInviteRequest.vue', 'components/CycleTimeline.vue',
      'lib/guest-cart.js',
    ]) {
      expect(files, `the walk reached ${deep}`).toContain(deep)
    }
  })

  test('⚠ no file in the guest closure says „kolo" or „cyklus" (comments stripped)', () => {
    const files = importClosure(GUEST_SURFACE_ROOTS)
    const offenders = []
    for (const file of files) {
      for (const [n, line] of bannedLines(file)) offenders.push(`${file}:${n} ${line}`)
    }
    expect(offenders, 'a guest-facing source file carries a banned word').toEqual([])
    assertReadable('views/GuestOrder.vue', ['preopen-hero', 'checkout-error'])
    assertReadable('views/GuestOrderStatus.vue', ['start-edit', 'edit-error'])
    assertReadable('components/GuestProductGrid.vue', ['emptyMessage', GUEST_COPY.empty])
  })

  test('⚠ the guest-facing SERVER source: `routes/guest.js` whole, `guest-orders.js` per audience', () => {
    // `routes/guest.js` is PUBLIC end to end — every message in it is a guest's.
    const guestSrc = stripComments(readBackend('routes/guest.js'))
    for (const token of ['resolveEntry', 'Tento odkaz na objednávku neexistuje', GUEST_COPY.closed, GUEST_COPY.editClosed]) {
      expect(guestSrc, `routes/guest.js: \`${token}\` survives the strip`).toContain(token)
    }
    expect(offendingLines(guestSrc), 'routes/guest.js: a guest-facing message says a banned word').toEqual([])

    // `routes/guest-orders.js` is a MIXED mount: the host's routes (and the shared
    // preamble) are swept; the `requireAdmin` routes are the admin's and may say „Cyklus".
    const blocks = routeBlocks('routes/guest-orders.js')
    // ⚠ The split is complete: one block per registration in the RAW file (an indented
    // or `router.use`/`router.route` registration would otherwise hide in its neighbour).
    expect(blocks.length - 1, 'guest-orders.js: every router registration starts its own block')
      .toBe(rawRegistrations('routes/guest-orders.js'))
    expect(blocks.length - 1, 'non-vacuity: the split found the shipped routes').toBeGreaterThanOrEqual(6)

    // ⚠ READABILITY, the strong form: every raw `error:`/`message:` literal of both
    // files survives the comment strip — the strings the sweep exists for were really read.
    for (const rel of ['routes/guest.js', 'routes/guest-orders.js']) {
      const stripped = stripComments(readBackend(rel))
      const literals = rawMessageLiterals(rel)
      expect(literals.length, `${rel}: non-vacuity — message literals found`).toBeGreaterThanOrEqual(10)
      const lost = literals.filter((lit) => !stripped.includes(lit))
      expect(lost, `${rel}: message literals eaten by the comment strip`).toEqual([])
    }
    const host = blocks.filter((b) => !b.admin)
    const adminBlocks = blocks.filter((b) => b.admin)
    expect(host.some((b) => b.header.startsWith("router.delete('/:id'")), 'non-vacuity: the host DELETE is a host block').toBe(true)
    expect(host.find((b) => b.header.startsWith("router.delete('/:id'")).body).toContain(GUEST_COPY.hostDeleteClosed)
    for (const b of host) {
      expect(offendingLines(b.body), `guest-orders.js ${b.header}: a friend-facing message says a banned word`).toEqual([])
    }
    // ⚠ THE AUDIENCE DECISION, PINNED: the admin cancel keeps „Cyklus". If this reds
    // because someone re-worded it, that is a PO/audience decision — change this pin
    // and learnings 11 §GL-T7 together, never one of them.
    const cancel = adminBlocks.find((b) => b.header.startsWith("router.post('/:id/cancel'"))
    expect(cancel, 'the admin cancel is registered with requireAdmin').toBeTruthy()
    expect(cancel.body).toContain(ADMIN_CANCEL_CLOSED)
  })
})

test.describe('GL-T7 · 19 §UC-GL-011 — the guest-facing server messages, live', () => {
  test('a locked round: guest submit, guest edit, host remove (swept) — and the admin cancel (kept)', async () => {
    const host = await makeFriend('GuestSrv')
    const cycle = await makeCycle(`GL7 Srv ${uniq}`)
    const product = await addProduct(cycle.id, { name: `GL7 Srv Bean ${uniq}`, purpose: 'Espresso', price_250g: 8 })
    const shared = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, {
      headers: { Authorization: `Bearer ${host.token}` }, timeout: TIMEOUT,
    })
    expect([200, 201], 'share link').toContain(shared.status())
    const { link } = await shared.json()
    const items = [{ product_id: product.id, variant: '250g', quantity: 1 }]
    const identity = { guest_name: 'Marek GL7', guest_phone: '0901 234 567' }
    const submitted = await ctx.post(`/api/guest/${link.token}/orders`, { data: { ...identity, items }, timeout: TIMEOUT })
    expect(submitted.status(), 'guest submit while open').toBe(201)
    const { order } = await submitted.json()

    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)

    // `routes/guest.js CLOSED` — rendered by `GuestOrder.vue`'s checkout-error banner.
    const late = await ctx.post(`/api/guest/${link.token}/orders`, { data: { ...identity, items }, timeout: TIMEOUT })
    expect(late.status(), 'status unchanged').toBe(409)
    expect(await late.json()).toEqual({ error: GUEST_COPY.closed, reason: 'closed' })

    // The status page's edit — rendered by `GuestOrderStatus.vue`'s edit-error banner.
    const edit = await ctx.put(`/api/guest/o/${order.order_token}`, { data: { items }, timeout: TIMEOUT })
    expect(edit.status(), 'status unchanged').toBe(409)
    expect(await edit.json()).toEqual({ error: GUEST_COPY.editClosed, reason: 'closed' })

    // The HOST's removal — `GuestSubOrders.vue` paints `e.message` on the Kolegovia tab.
    const removed = await ctx.delete(`/api/guest-orders/${order.id}`, {
      headers: { Authorization: `Bearer ${host.token}` }, timeout: TIMEOUT,
    })
    expect(removed.status(), 'status unchanged').toBe(409)
    expect(await removed.json()).toEqual({ error: GUEST_COPY.hostDeleteClosed, reason: 'closed' })

    // The ADMIN's cancel keeps „Cyklus" — the audience rule, decided on purpose.
    const cancelled = await admin(`/api/guest-orders/${order.id}/cancel`, { method: 'post' })
    expect(cancelled.status(), 'status unchanged').toBe(409)
    expect(await cancelled.json()).toEqual({ error: ADMIN_CANCEL_CLOSED, reason: 'closed' })

    for (const msg of Object.values(GUEST_COPY)) expect(BANNED.test(msg), `„${msg}" is clean`).toBe(false)
    expect(BANNED.test(ADMIN_CANCEL_CLOSED), 'non-vacuity: the kept admin string IS an offender').toBe(true)
  })
})

test.describe('GL-T7 · 19 §UC-GL-011 — the guest screens, rendered', () => {
  async function guestLink(label, { products = 1 } = {}) {
    const host = await makeFriend(label)
    const cycle = await makeCycle(`GL7 ${label} ${uniq}`)
    const made = []
    for (let i = 0; i < products; i++) {
      made.push(await addProduct(cycle.id, { name: `GL7 ${label} Bean ${i} ${uniq}`, purpose: 'Espresso', price_250g: 8 }))
    }
    const shared = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, {
      headers: { Authorization: `Bearer ${host.token}` }, timeout: TIMEOUT,
    })
    expect([200, 201], 'share link').toContain(shared.status())
    return { host, cycle, products: made, link: (await shared.json()).link }
  }
  const lock = async (cycle) => expect((await admin(`/api/cycles/${cycle.id}`, {
    method: 'patch', data: { status: 'locked' },
  })).status()).toBe(200)

  test('the LIVE listing of an open round with zero products — the grid\'s empty message', async ({ page }) => {
    const { link } = await guestLink('Empty', { products: 0 })
    await page.goto(`/g/${link.token}`)
    await expect(page.getByText(GUEST_COPY.empty)).toBeVisible()
    await expectCleanCopy(page, 'the live guest listing, zero products', [GUEST_COPY.empty, 'Objednávka cez odkaz'])
  })

  test('the checkout refused by a lock — `CLOSED` in the checkout-error banner', async ({ page }) => {
    const { cycle, products: [product], link } = await guestLink('Checkout')
    await page.goto(`/g/${link.token}`)
    await page.getByTestId(`product-${product.id}`).getByTestId('inc-250g').click()
    await page.getByTestId('open-checkout').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByTestId('guest-name').fill('Marek GL7')
    await dialog.getByTestId('guest-phone').fill('0901 234 567')
    await lock(cycle)
    await dialog.getByTestId('guest-submit').click()
    await expect(dialog.getByTestId('checkout-error')).toHaveText(GUEST_COPY.closed)
    await expectCleanCopy(page, 'the guest checkout, refused', [GUEST_COPY.closed])
  })

  test('the status page\'s EDIT mode, and its save refused by a lock', async ({ page }) => {
    const { cycle, products: [product], link } = await guestLink('Edit')
    const submitted = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'Marek GL7', guest_phone: '0901 234 567', items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
      timeout: TIMEOUT,
    })
    expect(submitted.status()).toBe(201)
    const { order } = await submitted.json()

    await page.goto(`/g/o/${order.order_token}`)
    await page.getByTestId('start-edit').click()
    // Edit mode mounts `GuestProductGrid` — the second surface 88's string rendered on.
    await expectCleanCopy(page, 'the guest status page, edit mode', ['Upravujete objednávku pre', 'Uložiť zmeny'])

    await lock(cycle)
    await page.getByTestId(`product-${product.id}`).getByTestId('inc-250g').click()
    await page.getByTestId('save-edit').click()
    // A 409 RELOADS the page into its read view (`submitEdit`), so the server's message
    // lands in the read view's `status-error` banner, beside the read-only notice.
    await expect(page.getByTestId('status-error')).toHaveText(GUEST_COPY.editClosed)
    await expectCleanCopy(page, 'the guest edit, refused',
      [GUEST_COPY.editClosed, 'Objednávky sú uzavreté, objednávku už nie je možné upraviť.'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GP-T7 · PO decision (2) 2026-09-24 — the lock copy is „uzavreté", never „uzamknuté"
// ═════════════════════════════════════════════════════════════════════════════
// On EVERY friend/guest surface (the SAME derived import closure as the ban above, so
// a new component is guarded by being imported) and in the friend-facing server
// messages. The ADMIN labels („Uzamknúť" / „Odomknúť" / „Uzamknutý", the board's
// „· uzamknuté", `cycles.js`) are deliberately untouched and outside this set.
test.describe('GP-T7 · the lock copy is „uzavreté" on every friend/guest surface', () => {
  test.skip(!HAS_SRC, NEEDS_SRC)
  const LOCK_OLD = /uzamk/iu

  test('no file in the friend + guest import closure says „uzamkn…" (comments stripped), and the new copy is really there', () => {
    const files = importClosure(VOCABULARY_ROOTS)
    expect(files, 'non-vacuity: the four PO-named files are in the swept set').toEqual(expect.arrayContaining([
      'views/FriendOrder.vue', 'views/FriendPortalSession.vue', 'components/LandingStateModal.vue', 'components/PortalExplainer.vue',
    ]))
    const offenders = []
    for (const file of files) {
      stripComments(readFileSync(join(FRONTEND_SRC, file), 'utf8')).split('\n').forEach((line, i) => {
        if (LOCK_OLD.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`)
      })
    }
    expect(offenders, 'a friend/guest source file still says „uzamknuté"').toEqual([])
    assertReadable('views/FriendOrder.vue', ['+++ OBJEDNÁVKY UZAVRETÉ +++ DRŽ JAZYK ZA ZUBAMI +++',
      'title="Objednávky sú uzavreté"', '<b>Objednávky sú uzavreté.</b>', 'Stále ju môžete upraviť až do uzavretia.',
      'Môžete ju upraviť až do uzavretia objednávok.'])
    assertReadable('views/FriendPortalSession.vue', ['+++ OBJEDNÁVKY UZAVRETÉ +++ KÁVA JE NA CESTE +++',
      "'Objednávky sú uzavreté' : 'Objednávky sú zatvorené'", 'title="Objednávky sú uzavreté"', '<b>Objednávky sú uzavreté.</b>'])
    assertReadable('components/PortalExplainer.vue', ['odošleš, do uzavretia môžeš meniť.'])
  })

  test('the friend-facing order routes\' two lock 403s say „Objednávky sú uzavreté"; the ADMIN strings stay', () => {
    const backend = (rel) => stripComments(readFileSync(resolve(FRONTEND_SRC, '../../backend/src', rel), 'utf8'))
    const orders = backend('routes/orders.js')
    expect(orders.match(/res\.status\(403\)\.json\(\{ error: 'Objednávky sú uzavreté' \}\)/g), 'both friend 403s').toHaveLength(2)
    expect(orders).not.toMatch(/uzamkn|Objednavky su/i)
    // Admin copy is OUT of the decision — pinned so a broad sed cannot „fix" it.
    expect(backend('routes/cycles.js')).toContain('Fázu možno meniť len pri uzamknutom cykle')
    const admin = (rel) => readFileSync(join(FRONTEND_SRC, rel), 'utf8')
    expect(admin('views/CycleDetail.vue')).toContain("'Odomknúť' : 'Uzamknúť'")
    expect(admin('views/AdminDashboard.vue')).toContain("return 'Uzamknutý'")
    expect(admin('views/Distribution.vue')).toContain("return '· uzamknuté'")
  })
})
