import { test, expect, request as playwrightRequest } from '@playwright/test'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { assertReadable, code, HAS_SRC, NEEDS_SRC } from '../helpers/source-pins.js'
import { expectLanding, openMenu } from '../helpers/portal.js'
import { makeAdmin } from '../helpers/admin.js'

// PI-T6 — 18 §UC-PI-009 („Moje objednávky", the history view) and §UC-PI-019
// item 17's `portal-history.spec.js`.
//
// ⚠⚠ THE PROPERTY THIS FILE EXISTS TO PROTECT FIRST: „Moje objednávky" owns a
// SECOND, SHORT status vocabulary (Odoslaná · V pražiarni · Balíme · Zabalená ·
// Odovzdaná · Vyzdvihnuté), deliberately NOT shared with module 17's long timeline
// labels („Objednávky uzavreté, káva objednaná v pražiarni", …). §UC-PI-009 says so
// in as many words and `frontend/src/lib/history-badges.js` argues it at length.
// This repo spends most of its rows collapsing duplicated strings into one home, so
// the next reader's instinct will be to „fix" this by importing `cycle-stages.js
// STEPS` — §1 below makes that a RED run rather than a judgement call.
//
// ⚠ WHAT THIS VIEW DOES NOT DO, pinned in §5 because an absent control is invisible
// to a reader: it never navigates into a round („Otvoriť" is a PO decision to omit,
// not an oversight) and it writes nothing at all. It is a reading surface.
//
// ⚠ HERMETIC, per the RD-FL-2 idiom: every test provisions its own friend. Where the
// LINES are under test the rounds are REAL (the lazy fetch hits
// `GET /orders/cycle/:id/friend/:id`, which a stub cannot make interesting); where a
// STATE matrix is under test `GET /friends/cycles` is stubbed against real or
// invented cycle ids, which is the only way to reach all six badge rows at once.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

// FUP-T27 — ONE home for the admin request path: it re-authenticates ONCE on a 401
// instead of trusting a token the next `POST /api/admin/login` anywhere in the suite
// silently rotates out. See `helpers/admin.js`.
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
  const username = `pi6_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `PI6 ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: '0900 000 000' } })
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
  return { id: row.id, name, username, token }
}

async function makeCycle(label, data = {}) {
  const name = `PI6 Round ${label} ${uniq}`
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name, type: 'coffee', status: 'open', ...data },
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

/**
 * A REAL round the friend REALLY ordered in — two products, so the expanded body
 * has something to group, plus an optional Packeta fee (the `deliveryExtras` line).
 *
 * ⚠ No `markup_ratio` is passed: `POST /api/cycles` does not read one and the column
 * defaults to 1.0, which is what makes the amounts below exact.
 */
async function orderedRound(friend, label, { status = null, stage = null, packeta = false } = {}) {
  const cycle = await makeCycle(label)
  const espresso = await addProduct(cycle.id, {
    name: `PI6 ${label} Espresso ${uniq}`, purpose: 'Espresso', price_250g: 8, stock_limit_g: 5000,
  })
  const filter = await addProduct(cycle.id, {
    name: `PI6 ${label} Filter ${uniq}`, purpose: 'Filter', price_250g: 10,
  })

  const body = {}
  if (packeta) {
    expect((await admin(`/api/cycles/${cycle.id}`, {
      method: 'patch', data: { parcel_enabled: true, parcel_fee: 3.5 },
    })).status(), 'parcel enabled').toBe(200)
    body.use_parcel_delivery = true
    body.packeta_address = `Z-BOX Hlavná 15, Bratislava ${uniq}`
  } else {
    body.pickup_location_note = `Pri fontáne ${uniq}`
  }

  expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
    items: [
      { product_id: espresso.id, variant: '250g', quantity: 2 },
      { product_id: filter.id, variant: '250g', quantity: 1 },
    ],
  })).status(), 'cart saved').toBe(200)
  expect((await friendCall(friend, `/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, body, 'post'))
    .status(), 'order submitted').toBe(200)

  if (status) {
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status } })).status(),
      `cycle → ${status}`).toBe(200)
  }
  if (stage) {
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { stage } })).status(),
      `stage → ${stage}`).toBe(200)
  }
  return { cycle, espresso, filter, packeta: body.packeta_address || null }
}

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

/** A cycle row shaped like `GET /friends/cycles` publishes one. */
const cycleRow = (over) => ({
  id: 86_000 + (over.n || 0), name: `PI6 Stub ${over.n || 0}`, status: 'completed',
  created_at: over.created_at || `2026-09-0${(over.n || 1) % 9 + 1} 10:00:00`,
  total_friends: 0, expected_date: null, type: 'coffee', plan_note: null,
  opens_at: null, closes_at: null, stage: null, parcel_enabled: 0, parcel_fee: 0,
  hasOrder: true, orderTotal: 26, orderStatus: 'submitted', orderKilos: 0.75, orderItemCount: 3,
  orderPickupName: null, orderPacketa: false, orderPaid: false, orderHandedOver: false,
  ...over,
})

async function stubCycles(page, cycles) {
  await page.route('**/api/friends/cycles*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(cycles),
  }))
}

/** The balance is PI-T7's surface; keep its request out of every fixture here. */
async function stubBalance(page) {
  await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))
}

/**
 * Land on a portal route with the cycles response already in.
 *
 * ⚠ It WAITS for `GET /friends/cycles`: `cycles` starts EMPTY on a restore, so an
 * assertion that fired early would read an empty history and „Zatiaľ žiadne
 * objednávky." would pass for entirely the wrong reason (PI-T1 §9).
 */
async function open(page, path = '/moje-objednavky') {
  const served = page.waitForResponse((r) => r.url().includes('/api/friends/cycles'), { timeout: TIMEOUT })
  await page.goto(path)
  await served
  await expectLanding(page)
}

const rounds = (page) => page.getByTestId('history-round')
const roundNamed = (page, name) => rounds(page).filter({ hasText: name })

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE SECOND VOCABULARY (§UC-PI-009's badge table, `lib/history-badges.js`)
// ═════════════════════════════════════════════════════════════════════════════
//
// `lib/history-badges.js` is dependency-free plain ESM (no Vue, no `@/` alias, no
// imports at all), so a Playwright worker imports it directly — this project has no
// unit runner and that import IS the unit test, the `cycle-stages.spec.js` §7 and
// `payment-links.spec.js` precedent. The gate is the frontend SOURCE TREE, never the
// lib file itself: „the module is missing" must be a red run, not a silent skip.

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../frontend/src')
const BADGES_LIB = join(SRC, 'lib/history-badges.js')
const STEPS_LIB = join(SRC, 'lib/cycle-stages.js')
const HAS_LIB = existsSync(SRC)

test.describe('PI-T6 · 18 §UC-PI-009 — the SHORT badge vocabulary is owned here', () => {
  test.skip(!HAS_LIB, NEEDS_SRC)

  let hb = null
  let cs = null
  test.beforeAll(async () => {
    hb = await import(pathToFileURL(BADGES_LIB).href)
    cs = await import(pathToFileURL(STEPS_LIB).href)
  })

  test('the six badges are exactly §UC-PI-009\'s table — text AND tone', () => {
    const b = hb.HISTORY_BADGES
    expect([b.submitted, b.ordered, b.arrived, b.ready, b.handed, b.completed]
      .map((x) => [x.text, x.tone]))
      .toEqual([
        ['Odoslaná', 'acc'],
        ['V pražiarni', ''],
        ['Balíme', 'acc'],
        ['Zabalená', 'acc'],
        ['Odovzdaná', 'ok'],
        ['Vyzdvihnuté', 'ok'],
      ])
  })

  test('⚠⚠ it is a SECOND vocabulary: not one of the six is module 17\'s label', () => {
    const short = Object.values(hb.HISTORY_BADGES).map((x) => x.text)
    const long = cs.STEPS.map((s) => s.label)

    // Non-vacuity first: an empty harvest on either side would make every
    // assertion below pass while proving nothing.
    expect(short, 'six short forms harvested').toHaveLength(6)
    expect(long, 'six long labels harvested').toHaveLength(6)

    for (const text of short) {
      expect(long, `„${text}" must not be one of module 17's labels`).not.toContain(text)
    }
    // …and the reverse direction, which is the one a „fix" would take: 17's labels
    // are sentences with commas, these are single words for a badge.
    expect(long.filter((l) => l.includes(',')).length,
      'module 17\'s labels really are the long, comma-carrying ones').toBeGreaterThan(2)
    expect(short.every((s) => !s.includes(',')), 'the history forms carry none').toBe(true)
    expect(Math.max(...short.map((s) => s.length)),
      'the longest short form is shorter than the shortest long one')
      .toBeLessThan(Math.min(...long.map((l) => l.length)))
  })

  test('the badge matrix, row by row — including status-before-stage', () => {
    const t = (cycle) => hb.historyBadge(cycle).text

    expect(t({ status: 'open' })).toBe('Odoslaná')
    expect(t({ status: 'locked', stage: 'ordered' })).toBe('V pražiarni')
    // CS-T1 forbids a backfill, so every locked round predating module 17 is NULL.
    expect(t({ status: 'locked', stage: null })).toBe('V pražiarni')
    expect(t({ status: 'locked', stage: 'arrived' })).toBe('Balíme')
    expect(t({ status: 'locked', stage: 'ready' })).toBe('Zabalená')
    // „locked | any | true ⇒ Odovzdaná" — `orderHandedOver` outranks the stage.
    expect(t({ status: 'locked', stage: 'ordered', orderHandedOver: true })).toBe('Odovzdaná')
    expect(t({ status: 'locked', stage: 'ready', orderHandedOver: true })).toBe('Odovzdaná')
    expect(t({ status: 'completed' })).toBe('Vyzdvihnuté')

    // ⚠ STATUS BEFORE STAGE, the rule 17's `stageIndex()` documents and CS-T1
    // measured: `completed(ready) → open` leaves a stale `stage = 'ready'` behind,
    // and reading `stage` first would badge that round „Zabalená" forever.
    expect(t({ status: 'open', stage: 'ready' }), 'a stale stage never outranks status')
      .toBe('Odoslaná')
    expect(t({ status: 'completed', stage: 'ordered', orderHandedOver: true }),
      'a completed round is „Vyzdvihnuté" whatever the hand-over says').toBe('Vyzdvihnuté')

    // Junk fails to the one claim `hasOrder` already guarantees.
    expect(t(null)).toBe('Odoslaná')
    expect(t({ status: 'planned' })).toBe('Odoslaná')
  })

  test('source pin: the badge file imports nothing from module 17', () => {
    test.skip(!HAS_SRC, NEEDS_SRC)
    assertReadable('lib/history-badges.js', ['HISTORY_BADGES', 'historyBadge', 'Vyzdvihnuté'])
    const src = code('lib/history-badges.js')
    // ⚠ The STRIPPED source: the file's header discusses `cycle-stages` at length on
    // purpose, and this pin is about what it EXECUTES.
    expect(src, 'the short forms are typed here, never derived from 17\'s STEPS')
      .not.toContain('cycle-stages')
    expect(src).not.toContain('STEPS')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE LIST — which rounds, in which order, with which badge (§UC-PI-009)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T6 · 18 §UC-PI-009 — the rounds list', () => {
  test('six rounds, six badges — the whole table rendered, newest first', async ({ page }) => {
    const friend = await makeFriend('Matrix')
    await signIn(page, friend)
    await stubBalance(page)
    // The payload's order IS the rendered order (§UC-PI-009: „newest first (API
    // order)"); `GET /friends/cycles` sorts `created_at DESC` server-side.
    await stubCycles(page, [
      cycleRow({ n: 1, name: `PI6 M Open ${uniq}`, status: 'open', orderTotal: 26 }),
      cycleRow({ n: 2, name: `PI6 M Ordered ${uniq}`, status: 'locked', stage: 'ordered' }),
      cycleRow({ n: 3, name: `PI6 M Arrived ${uniq}`, status: 'locked', stage: 'arrived' }),
      cycleRow({ n: 4, name: `PI6 M Ready ${uniq}`, status: 'locked', stage: 'ready' }),
      cycleRow({ n: 5, name: `PI6 M Handed ${uniq}`, status: 'locked', stage: 'ready', orderHandedOver: true }),
      cycleRow({ n: 6, name: `PI6 M Done ${uniq}`, status: 'completed', orderTotal: 13.5 }),
    ])
    await open(page)

    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'history')
    await expect(page.getByRole('heading', { name: 'Moje objednávky' })).toBeVisible()
    await expect(rounds(page)).toHaveCount(6)
    await expect(page.getByTestId('history-badge')).toHaveText(
      ['Odoslaná', 'V pražiarni', 'Balíme', 'Zabalená', 'Odovzdaná', 'Vyzdvihnuté'])

    // The names in payload order, i.e. the list really is „newest first" and not
    // re-sorted by anything this view invented.
    await expect(rounds(page).locator('.display').first()).toHaveText(`PI6 M Open ${uniq}`)
    await expect(rounds(page).nth(5)).toContainText(`PI6 M Done ${uniq}`)

    // The tones, which are half of the table: neutral for „V pražiarni", accent
    // while it is moving, `ok` once it is done.
    await expect(roundNamed(page, `PI6 M Ordered ${uniq}`).getByTestId('history-badge')).toHaveClass(/^badge$/)
    await expect(roundNamed(page, `PI6 M Arrived ${uniq}`).getByTestId('history-badge')).toHaveClass(/^badge acc$/)
    await expect(roundNamed(page, `PI6 M Done ${uniq}`).getByTestId('history-badge')).toHaveClass(/^badge ok$/)

    // Totals: `orderTotal` is the server's `total + delivery_fee`, EUR on a total.
    await expect(roundNamed(page, `PI6 M Open ${uniq}`).getByTestId('history-total')).toHaveText('26.00 EUR')
    await expect(roundNamed(page, `PI6 M Done ${uniq}`).getByTestId('history-total')).toHaveText('13.50 EUR')

    // The CURRENT round (open or locked) is highlighted, the past ones are flat.
    await expect(roundNamed(page, `PI6 M Open ${uniq}`)).toHaveClass(/\bhl\b/)
    await expect(roundNamed(page, `PI6 M Ready ${uniq}`)).toHaveClass(/\bhl\b/)
    await expect(roundNamed(page, `PI6 M Done ${uniq}`)).toHaveClass(/\bflat\b/)
    await expect(roundNamed(page, `PI6 M Done ${uniq}`)).not.toHaveClass(/\bhl\b/)
  })

  test('only rounds the friend ORDERED in — a browsed round is not an objednávka', async ({ page }) => {
    // Resolved conflict 8, against the REAL payload: no stub, so this also pins that
    // `hasOrder` on the wire is what the view filters on.
    const friend = await makeFriend('Filter')
    const ordered = await orderedRound(friend, 'Filter')
    const untouched = await makeCycle('Untouched')

    await signIn(page, friend)
    await stubBalance(page)
    await open(page)

    await expect(roundNamed(page, ordered.cycle.name)).toHaveCount(1)
    await expect(roundNamed(page, untouched.name), 'a round with no order of mine is absent')
      .toHaveCount(0)
    // Non-vacuity: the untouched round really exists and really is visible to this
    // friend — it is the landing's own offer.
    const cycles = await friendCall(friend, '/api/friends/cycles?friendId=' + friend.id, undefined, 'get')
    const body = await cycles.json()
    expect(body.some((c) => c.name === untouched.name && !c.hasOrder),
      'the payload carries it with hasOrder false').toBe(true)
  })

  test('the drawer item and the list count the SAME rounds', async ({ page }) => {
    // §UC-PI-004 item 2's sub-line („{n} objednávky · naposledy {name}") and this
    // view read one computed; they can never disagree about the number on screen.
    const friend = await makeFriend('Drawer')
    await signIn(page, friend)
    await stubBalance(page)
    await stubCycles(page, [
      cycleRow({ n: 11, name: `PI6 D One ${uniq}`, status: 'completed' }),
      cycleRow({ n: 12, name: `PI6 D Two ${uniq}`, status: 'completed' }),
      cycleRow({ n: 13, name: `PI6 D Skip ${uniq}`, status: 'completed', hasOrder: false }),
    ])
    // ⚠ Opened ON the history view, not on `/`: a stub of three COMPLETED rounds
    // makes the landing `closed`, and PI-T4's state modal would then cover the
    // hamburger with its scrim (learnings 10 §11). The non-`shop` views never mount
    // it, which is the cheaper way past the same obstacle.
    await open(page)

    await expect(rounds(page)).toHaveCount(2)
    await openMenu(page)
    await expect(page.getByRole('dialog', { name: 'Menu' }))
      .toContainText(`2 objednávky · naposledy PI6 D One ${uniq}`)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE LAZY LINE LIST (§UC-PI-009: „fetched lazily on first expand … cached")
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T6 · 18 §UC-PI-009 — expanding a round', () => {
  /** Count every friend-order GET the page makes, per cycle id. */
  async function countOrderGets(page, counts) {
    await page.route('**/api/orders/cycle/*/friend/*', async (route) => {
      const id = route.request().url().match(/\/cycle\/(\d+)\//)?.[1]
      if (id) counts[id] = (counts[id] || 0) + 1
      await route.continue()
    })
  }

  test('nothing is fetched until a round is opened, then exactly once', async ({ page }) => {
    const friend = await makeFriend('Lazy')
    const a = await orderedRound(friend, 'LazyA', { status: 'completed' })
    const b = await orderedRound(friend, 'LazyB', { status: 'completed' })

    await signIn(page, friend)
    await stubBalance(page)
    const counts = {}
    await countOrderGets(page, counts)
    await stubCycles(page, [
      cycleRow({ n: 21, id: a.cycle.id, name: a.cycle.name, status: 'completed', orderTotal: 26 }),
      cycleRow({ n: 22, id: b.cycle.id, name: b.cycle.name, status: 'completed', orderTotal: 26 }),
    ])
    await open(page)

    await expect(rounds(page)).toHaveCount(2)
    expect(counts, 'a list of thirty rounds costs zero order requests').toEqual({})

    await roundNamed(page, a.cycle.name).click()
    const lines = roundNamed(page, a.cycle.name).locator('li.ln')
    await expect(lines).toHaveCount(2)
    await expect(lines.first()).toContainText(a.espresso.name)
    // `€` on a line (CLAUDE.md §Frontend), and the amount is `price × quantity`
    // from the SNAPSHOT price the server stored at submit — 2 × 8.00.
    await expect(lines.first()).toContainText('16.00 €')
    await expect(lines.nth(1)).toContainText('10.00 €')
    // `CartLineList` groups by purpose, which only works because the order GET
    // publishes `p.purpose` (PI-T5): this view never loads the round's catalogue.
    await expect(roundNamed(page, a.cycle.name).locator('li.ln-group')).toHaveText(['Espresso', 'Filter'])
    expect(counts[String(a.cycle.id)], 'one request for the round that was opened').toBe(1)
    expect(counts[String(b.cycle.id)], 'and none for the one that was not').toBeUndefined()

    // Collapse, re-expand: cached for the session, so no second request.
    await roundNamed(page, a.cycle.name).click()
    await expect(roundNamed(page, a.cycle.name).locator('li.ln')).toHaveCount(0)
    await roundNamed(page, a.cycle.name).click()
    await expect(roundNamed(page, a.cycle.name).locator('li.ln')).toHaveCount(2)
    expect(counts[String(a.cycle.id)], 'the cache answers the second expand').toBe(1)
  })

  test('the Packeta fee is a line of its own, and the total is the server\'s', async ({ page }) => {
    const friend = await makeFriend('Fee')
    const fx = await orderedRound(friend, 'Fee', { status: 'completed', packeta: true })

    await signIn(page, friend)
    await stubBalance(page)
    await open(page)

    const card = roundNamed(page, fx.cycle.name)
    // 2×8 + 1×10 + 3.50 — the row comes from the REAL payload here, not a stub.
    await expect(card.getByTestId('history-total')).toHaveText('29.50 EUR')
    await card.click()
    await expect(card.locator('li.ln')).toHaveCount(3)
    await expect(card.locator('li.ln').last()).toContainText('Doručenie Packetou')
    await expect(card.locator('li.ln').last()).toContainText('3.50 €')
  })

  test('ONE round is expanded at a time', async ({ page }) => {
    const friend = await makeFriend('Solo')
    const a = await orderedRound(friend, 'SoloA', { status: 'completed' })
    const b = await orderedRound(friend, 'SoloB', { status: 'completed' })

    await signIn(page, friend)
    await stubBalance(page)
    await stubCycles(page, [
      cycleRow({ n: 31, id: a.cycle.id, name: a.cycle.name, status: 'completed' }),
      cycleRow({ n: 32, id: b.cycle.id, name: b.cycle.name, status: 'completed' }),
    ])
    await open(page)

    await roundNamed(page, a.cycle.name).click()
    await expect(roundNamed(page, a.cycle.name).locator('li.ln')).toHaveCount(2)
    await expect(roundNamed(page, a.cycle.name).locator('li.ln').first()).toContainText(a.espresso.name)

    await roundNamed(page, b.cycle.name).click()
    await expect(roundNamed(page, b.cycle.name).locator('li.ln')).toHaveCount(2)
    // ⚠ The CONTENT, not just the count: a single shared line cache renders two
    // lines here too — A's — and a count-only assertion would call that green.
    await expect(roundNamed(page, b.cycle.name).locator('li.ln').first()).toContainText(b.espresso.name)
    await expect(roundNamed(page, a.cycle.name).locator('li.ln'),
      'opening one round closes the other').toHaveCount(0)
    // Every line on screen belongs to the one open round.
    await expect(page.locator('[data-testid="history-round"] li.ln')).toHaveCount(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE PER-ROW GUARDS (§UC-PI-009: „per-row pending + a per-row `rowSeq`";
//    CLAUDE.md §Frontend: per-row mutations need per-id pending state)
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠ WHAT EACH HALF ACTUALLY PROTECTS — measured (PI-T6), not asserted by faith:
//
//   · the per-row PENDING flag is load-bearing today: one shared flag reds the first
//     test below (M4 — a round whose lines are already cached renders „Načítavam…"
//     because ANOTHER round's request is in flight).
//   · the KEYED CACHE is load-bearing today: one shared `lines`/`pending` pair reds
//     three (M5′ — both tests below plus §3's „ONE round is expanded at a time",
//     which is why that test asserts the LINES' CONTENT and not just their count).
//   · the per-row `roundSeq` counter is DEFENCE IN DEPTH and reds NOTHING on its own
//     (M5 = 15/15 green): the keyed cache and the „no second fetch while one is
//     pending" rule already make a stale write unreachable. It is documented as such
//     at its definition rather than dropped — the PI-T5 §9 precedent — and this
//     comment says so instead of claiming an assertion that does not exist.
//
// ⚠ A HELD RESPONSE NEEDS A REAL DELAY on this box: `page.route` + a timer, ≥4 s
// (CLAUDE.md §Running the e2e suite — a shorter one lets the „slow" request land
// before the next click and both halves pass for the wrong reason).
//
// ⚠⚠ AND THE HOLD MUST OUTLAST THE ASSERTION THAT MEASURES IT, which the 4 s rule
// alone does not give you. `expect` RETRIES for `expect.timeout` (10 s here), so an
// assertion made while a 5 s request is held simply waits for the response, watches
// the defect repair itself and reports green. Measured, PI-T6: with a 5 s hold the
// „one shared pending flag" mutation (M4) passed all 15 tests. So the two
// discriminating assertions below carry an IMPATIENT timeout that expires while the
// request is still in flight, and the hold is comfortably longer than it.
const HOLD_MS = 8_000
const IMPATIENT = { timeout: 3_000 }

test.describe('PI-T6 · 18 §UC-PI-009 — one row\'s request never paints another row', () => {
  test('a cached round renders its OWN lines while another round is still loading', async ({ page }) => {
    const friend = await makeFriend('Pending')
    const slow = await orderedRound(friend, 'PendSlow', { status: 'completed' })
    const fast = await orderedRound(friend, 'PendFast', { status: 'completed' })

    await signIn(page, friend)
    await stubBalance(page)
    // Only the SLOW round's request is held.
    await page.route(`**/api/orders/cycle/${slow.cycle.id}/friend/*`, async (route) => {
      await new Promise((r) => setTimeout(r, HOLD_MS))
      await route.continue()
    })
    await stubCycles(page, [
      cycleRow({ n: 41, id: slow.cycle.id, name: slow.cycle.name, status: 'completed' }),
      cycleRow({ n: 42, id: fast.cycle.id, name: fast.cycle.name, status: 'completed' }),
    ])
    await open(page)

    // 1. Load the fast round, so it is CACHED.
    await roundNamed(page, fast.cycle.name).click()
    await expect(roundNamed(page, fast.cycle.name).locator('li.ln')).toHaveCount(2)
    await roundNamed(page, fast.cycle.name).click()

    // 2. Open the slow one: its own row says „Načítavam...".
    // ⚠ The waiter is registered BEFORE the click, not in step 4: `waitForResponse`
    // only sees responses that arrive after it is called, and a held request that
    // landed while step 3 was asserting would make step 4 hang for no reason.
    const slowLanded = page.waitForResponse(
      (r) => r.url().includes(`/cycle/${slow.cycle.id}/friend/`), { timeout: TIMEOUT })
    await roundNamed(page, slow.cycle.name).click()
    await expect(roundNamed(page, slow.cycle.name).getByTestId('history-loading')).toBeVisible()

    // 3. …and while that request is STILL in flight, re-open the cached round.
    //    With one shared pending flag this row renders the loading text instead of
    //    its lines; with one shared line cache it renders the wrong round's lines
    //    a moment later.
    await roundNamed(page, fast.cycle.name).click()
    await expect(roundNamed(page, fast.cycle.name).locator('li.ln'),
      'the cached round paints instantly, from its own cache entry').toHaveCount(2, IMPATIENT)
    await expect(page.getByTestId('history-loading'),
      'another round\'s in-flight request is not this row\'s business').toHaveCount(0, IMPATIENT)
    await expect(roundNamed(page, fast.cycle.name).locator('li.ln').first())
      .toContainText(fast.espresso.name)

    // 4. Let the held response land. It belongs to a row nobody is looking at, and
    //    it must change nothing on screen.
    await slowLanded
    await expect(roundNamed(page, fast.cycle.name).locator('li.ln')).toHaveCount(2)
    await expect(roundNamed(page, fast.cycle.name).locator('li.ln').first())
      .toContainText(fast.espresso.name)
    await expect(roundNamed(page, slow.cycle.name).locator('li.ln'),
      'and the collapsed row stays collapsed').toHaveCount(0)
  })

  test('a round that FAILS shows its error inside its own card, and the next one still works', async ({ page }) => {
    const friend = await makeFriend('Err')
    const bad = await orderedRound(friend, 'ErrBad', { status: 'completed' })
    const good = await orderedRound(friend, 'ErrGood', { status: 'completed' })

    await signIn(page, friend)
    await stubBalance(page)
    let failNext = true
    await page.route(`**/api/orders/cycle/${bad.cycle.id}/friend/*`, async (route) => {
      if (!failNext) return route.continue()
      failNext = false
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Chyba servera' }) })
    })
    await stubCycles(page, [
      cycleRow({ n: 51, id: bad.cycle.id, name: bad.cycle.name, status: 'completed' }),
      cycleRow({ n: 52, id: good.cycle.id, name: good.cycle.name, status: 'completed' }),
    ])
    await open(page)

    await roundNamed(page, bad.cycle.name).click()
    await expect(roundNamed(page, bad.cycle.name).getByTestId('history-error')).toContainText('Chyba servera')
    // The failure is ONE row's. It is not the page-level banner, and it does not
    // follow the friend into the next card.
    await expect(page.getByTestId('history-error')).toHaveCount(1)

    await roundNamed(page, good.cycle.name).click()
    await expect(roundNamed(page, good.cycle.name).locator('li.ln')).toHaveCount(2)
    await expect(page.getByTestId('history-error'), 'the error collapsed with its own row').toHaveCount(0)

    // A failed round is not cached as „done": re-opening it retries.
    await roundNamed(page, bad.cycle.name).click()
    await expect(roundNamed(page, bad.cycle.name).locator('li.ln')).toHaveCount(2)
    await expect(page.getByTestId('history-error')).toHaveCount(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. READ-ONLY, AND THE RETIRED WORDS (§UC-PI-009, 03 §UC-FL-008 superseded)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T6 · 18 §UC-PI-009 — a reading surface', () => {
  test('clicking a round expands it and navigates NOWHERE — no „Otvoriť", no „Archív"', async ({ page }) => {
    const friend = await makeFriend('Read')
    const fx = await orderedRound(friend, 'Read', { status: 'completed' })

    await signIn(page, friend)
    await stubBalance(page)
    await open(page)

    const card = roundNamed(page, fx.cycle.name)
    await card.click()
    await expect(card.locator('li.ln')).toHaveCount(2)
    expect(new URL(page.url()).pathname, 'the card toggles, it does not navigate')
      .toBe('/moje-objednavky')

    // PO decision, not an oversight: there is no link into the round.
    await expect(page.getByRole('link', { name: 'Otvoriť' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Otvoriť' })).toHaveCount(0)
    await expect(page.locator('[data-testid="history-round"] a'),
      'no round carries a link of any kind').toHaveCount(0)

    // 03 §UC-FL-008's fold is superseded, and its word with it.
    await expect(page.getByText(/Arch[íi]v/i)).toHaveCount(0)

    // Read-only: no cart, no stepper, no submit anywhere on this view.
    await expect(page.locator('.app .cartbar')).toHaveCount(0)
    await expect(page.getByTestId('product-card')).toHaveCount(0)
  })

  test('the card is keyboard-operable (Enter toggles, and says so)', async ({ page }) => {
    const friend = await makeFriend('Kbd')
    const fx = await orderedRound(friend, 'Kbd', { status: 'completed' })

    await signIn(page, friend)
    await stubBalance(page)
    await open(page)

    const card = roundNamed(page, fx.cycle.name)
    await expect(card).toHaveAttribute('aria-expanded', 'false')
    await card.focus()
    await page.keyboard.press('Enter')
    await expect(card).toHaveAttribute('aria-expanded', 'true')
    await expect(card.locator('li.ln')).toHaveCount(2)
    await page.keyboard.press('Enter')
    await expect(card).toHaveAttribute('aria-expanded', 'false')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE EMPTY STATE (§UC-PI-009)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T6 · 18 §UC-PI-009 — nothing ordered yet', () => {
  test('„Zatiaľ žiadne objednávky." + the way back to the offer', async ({ page }) => {
    const friend = await makeFriend('Empty')
    await signIn(page, friend)
    await stubBalance(page)
    await open(page)

    await expect(rounds(page)).toHaveCount(0)
    await expect(page.getByTestId('history-empty')).toContainText('Zatiaľ žiadne objednávky.')
    // The heading still renders — an empty view is not a blank one.
    await expect(page.getByRole('heading', { name: 'Moje objednávky' })).toBeVisible()

    await page.getByRole('link', { name: 'Prezrieť aktuálnu ponuku' }).click()
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'shop')
    expect(new URL(page.url()).pathname).toBe('/')
  })
})
