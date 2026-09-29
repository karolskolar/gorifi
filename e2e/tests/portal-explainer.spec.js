import { test, expect, request as playwrightRequest } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'
import { assertReadable, code, HAS_SRC, NEEDS_SRC } from '../helpers/source-pins.js'
import { expectLanding, menuGo } from '../helpers/portal.js'
import { makeAdmin } from '../helpers/admin.js'

// PI-T8 — 18 §UC-PI-012 („Ako to funguje") and §UC-PI-014 (`lib/roasters.js` + the
// product card's roaster popover). §UC-PI-019 item 17's `portal-explainer.spec.js`,
// content half.
//
// ⚠⚠ THE PROPERTY THIS FILE EXISTS TO PROTECT FIRST: the explainer's six phases are
// STATIC TEXT and the LIVE TIMELINE IS NOT MOUNTED HERE. `CycleTimeline.vue` renders
// the same six steps, the copy lines up, and every reader's instinct will be that the
// explainer „should" show it — §UC-PI-012 item 3 says otherwise in as many words. The
// two answer different questions: this page explains the process to a friend who may
// have no round in flight at all (phase 1 is „Väčšinu času sa neobjednáva"), the
// timeline reports where ONE round is now. §1 makes mounting it a RED run rather than
// a judgement call, in both directions — the import is forbidden AND the six static
// phases are pinned.
//
// ⚠ THE SECOND PROPERTY: `lib/roasters.js` is a ONE HOME with a NAMED NON-CONSUMER.
// The explainer's two cards, the product badge's popover and (module 19, GL-T4) the
// guest line all read the same two strings; the ADMIN skin imports none of it. §3
// asserts the explainer's rendered text EQUAL to the module's exports, and §7 sweeps
// `frontend/src` for importers — an unmeasured boundary is the one that drifts.
//
// ⚠ HERMETIC, per the RD-FL-2 idiom: every test provisions its own friend. The
// PICKUP feed and the cycles payload are stubbed where their CONTENT is under test
// (a shared DB cannot be made to hold „exactly two coffee points" for one file), and
// REAL where the product cards are (a stub cannot make a roastery badge interesting).

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
/**
 * A fresh friend with their own username + password.
 *
 * ⚠ `explainer_seen_at` IS NULL ON EVERY FRIEND THIS MAKES, and PI-T9 depends on it:
 * `POST /api/friends` writes no credentials and no acknowledgement, and the API login
 * below is not the browser, so nothing stamps the column. That is the fixture §9's
 * gate tests need and the reason they provision their own friend rather than reuse a
 * seeded one (`e2e/seed.mjs` stamps everyone it seeds except its one named fixture).
 *
 * `opts.keepForcedChange` leaves `must_change_password` raised — the admin reset is
 * what sets it, and the ordinary path clears it with a change-password call. §9's
 * precedence test is the one caller that wants it left up.
 */
async function makeFriend(label, opts = {}) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `pi8_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `PI8 ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: '0900 000 000' } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()
  if (opts.keepForcedChange) {
    return { id: row.id, name, username, password: 'initPass1', token: body.token }
  }
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token
  return { id: row.id, name, username, password: 'ownPass12', token }
}

async function makeCycle(label, data = {}) {
  const name = `PI8 Round ${label} ${uniq}`
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
  id: 88_000 + (over.n || 0), name: `PI8 Stub ${over.n || 0}`, status: 'planned',
  created_at: over.created_at || `2026-09-0${(over.n || 1) % 9 + 1} 10:00:00`,
  total_friends: 0, expected_date: null, type: 'coffee', plan_note: null,
  opens_at: null, closes_at: null, stage: null, parcel_enabled: 0, parcel_fee: 0,
  hasOrder: false, orderTotal: 0, orderStatus: null, orderKilos: 0, orderItemCount: 0,
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
 * The public pickup feed, stubbed — and it RECORDS every URL it was asked for.
 * ~~§UC-PI-012 item 4 composes the pickup row from `getPickupLocations('coffee')`~~ —
 * SUPERSEDED by the PO copy pass 2026-09-29: the row is a static sentence and the
 * explainer asks the feed NOTHING. The stub stays so a stray fetch has somewhere to
 * land AND so §4 can prove none happens.
 */
function stubPickup(page, rows) {
  const seen = []
  page.route('**/api/pickup-locations*', (route) => {
    seen.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) })
  })
  return seen
}

/**
 * Land on a portal route with the cycles response already in.
 *
 * ⚠ It WAITS for `GET /friends/cycles`: `cycles` starts EMPTY on a restore, so the
 * resolver answers `closed` before the payload lands and the Packeta badge would be
 * read off the wrong round (PI-T1 §9).
 */
async function open(page, path = '/ako-to-funguje') {
  const served = page.waitForResponse((r) => r.url().includes('/api/friends/cycles'), { timeout: TIMEOUT })
  await page.goto(path)
  await served
  await expectLanding(page)
}

const explainer = (page) => page.getByTestId('portal-explainer')
const phases = (page) => page.getByTestId('explainer-phase')
const ways = (page) => page.getByTestId('explainer-way')
const roasterCards = (page) => page.getByTestId('explainer-roaster')

// The six phases, exactly as §UC-PI-012 item 3 writes them. Typed HERE as well as in
// the component on purpose: a spec that harvested them from the source it is testing
// would pass against any copy at all.
const PHASE_TITLES = ['Čas na kávu', 'Ohlásenie objednávky', 'Objednávanie', 'Čakáme na pražiareň', 'Balíme', 'Odovzdanie']

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../frontend/src')
const ROASTERS_LIB = join(SRC, 'lib/roasters.js')
const HAS_LIB = existsSync(SRC)

// ═════════════════════════════════════════════════════════════════════════════
// 1. ⚠⚠ THE SIX PHASES ARE STATIC TEXT — THE LIVE TIMELINE IS NOT MOUNTED
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T8 · 18 §UC-PI-012 item 3 — static phases, no CycleTimeline', () => {
  test('all six phases render, numbered 1–6, in the spec\'s order', async ({ page }) => {
    const friend = await makeFriend('Phases')
    await signIn(page, friend)
    await stubBalance(page)
    await stubPickup(page, [])
    await stubCycles(page, [cycleRow({ n: 1 })])
    await open(page)

    await expect(explainer(page)).toBeVisible()
    await expect(phases(page)).toHaveCount(6)
    for (let i = 0; i < 6; i++) {
      const phase = phases(page).nth(i)
      await expect(phase.locator('.n'), `phase ${i + 1} is numbered`).toHaveText(String(i + 1))
      await expect(phase.locator('.display')).toHaveText(PHASE_TITLES[i])
      // Each phase carries ITS OWN glyph — the `I2` set PI-T8 added to `icons.js`.
      // An unknown `NeoIcon` name renders NOTHING (it is silent in production), so
      // a mistyped icon key would be invisible without this.
      await expect(phase.locator('.ico svg'), `phase ${i + 1} has a glyph`).toHaveCount(1)
    }

    // The WhatsApp mention in phase 2 is a PO decision (§UC-PI-012 item 3's `OPEN:`
    // resolved to „keep" — the PO already messages friends personally; module 21
    // automates it). It reads like an implementation detail and is not.
    await expect(phases(page).nth(1)).toContainText('V appke aj cez WhatsApp.')
    await expect(phases(page).nth(0)).toContainText('košík je zamknutý')
    await expect(phases(page).nth(4)).toContainText('Vtedy je čas zaplatiť.')
  })

  test('⚠⚠ NO live timeline on this page — in the DOM and in the source', async ({ page }) => {
    const friend = await makeFriend('NoTimeline')
    await signIn(page, friend)
    await stubBalance(page)
    await stubPickup(page, [])
    // A LOCKED round the friend ORDERED in: the state in which `CycleTimeline` would
    // have the most to say (§UC-PI-007 item 3's „Kde je vaša káva"), and therefore
    // the state in which mounting it here is most tempting.
    // ⚠ `hasOrder: true` is load-bearing — a locked landing with NO own order gets
    // the state MODAL instead of the own-order card, and with it no timeline at all.
    // ⚠ NON-VACUITY: the absence assertion below is worthless unless the timeline
    // CAN render in this session — so the locked landing is visited first and its
    // timeline asserted PRESENT, then the explainer's absence means something.
    await stubCycles(page, [cycleRow({ n: 2, status: 'locked', stage: 'arrived', hasOrder: true })])
    await open(page, '/')
    await expect(page.getByTestId('cycle-timeline'), 'non-vacuity: the timeline does render in this app')
      .toBeVisible()

    await menuGo(page, 'Ako to funguje')
    await expect(explainer(page)).toBeVisible()
    await expect(page.getByTestId('cycle-timeline'), 'no timeline on the explainer').toHaveCount(0)
    // …and not its dots variant either — `CycleTimeline` renders one or the other.
    await expect(page.locator('.cs-dots'), 'nor the compact variant').toHaveCount(0)
  })

  test('source pin: neither the view nor the lib imports module 17\'s timeline', () => {
    test.skip(!HAS_SRC, NEEDS_SRC)
    const view = assertReadable('components/PortalExplainer.vue', ['PHASES', 'Odovzdanie', 'roasters'])
    expect(view, 'the phases are typed here, never derived from 17\'s STEPS')
      .not.toContain('cycle-stages')
    expect(view).not.toContain('CycleTimeline')
    expect(view).not.toContain('timelineSteps')

    const lib = assertReadable('lib/roasters.js', ['ROASTERS', 'roasterFor', 'Goriffee'])
    // ⚠ DEPENDENCY-FREE: a Playwright worker imports this file directly (§2 below),
    // which is this repo's substitute for a unit test. One `@/` alias or one Vue
    // import and that import throws — loudly, but only after someone has to work out
    // why. `import` with no following `.meta` is the shape that matters.
    expect(lib.match(/\bimport\s/g), 'lib/roasters.js imports nothing at all').toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. `lib/roasters.js` AS A UNIT (18 §UC-PI-014)
// ═════════════════════════════════════════════════════════════════════════════
//
// Dependency-free plain ESM, so a worker imports it directly — the
// `lib/history-badges.js` / `lib/cycle-stages.js` / `lib/payment-links.js`
// precedent. The gate is the frontend SOURCE TREE, never the lib file itself: „the
// module is missing" must be a red run, not a silent skip.
test.describe('PI-T8 · 18 §UC-PI-014 — the roasters library', () => {
  test.skip(!HAS_LIB, NEEDS_SRC)

  let lib = null
  test.beforeAll(async () => { lib = await import(pathToFileURL(ROASTERS_LIB).href) })

  test('two roasters, in order, with §UC-PI-014\'s exact labels and badge classes', () => {
    expect(lib.ROASTERS.map((r) => [r.key, r.label, r.badgeClass]))
      .toEqual([
        ['goriffee', 'Goriffee', ''],
        ['robo', 'Robo', 'acc-o'],
      ])
    // Q13.a, recorded: the badge stays „Robo" — there is no „domáce praženie" variant
    // of it, however much the text below describes home roasting.
    expect(lib.ROASTERS.map((r) => r.label)).not.toContain('Domáce praženie')
  })

  test('the two texts are the PO\'s drafts, byte for byte', () => {
    const [goriffee, robo] = lib.ROASTERS
    expect(goriffee.text).toBe(
      'Pražiareň — stály základ ponuky. Espresso aj filter, čerstvo pražené na objednávku.')
    expect(robo.text).toBe(
      'Domáci pražič. Hľadá zelenú kávu s vysokým hodnotením SCA (Specialty Coffee Association) '
      + 'a praží ju sám, v malých dávkach — všetko pod jeho značkou je ručne pražené doma.')
  })

  test('roasterFor() — the matrix, both directions', () => {
    const key = (name) => lib.roasterFor(name)?.key ?? null

    expect(key('Goriffee')).toBe('goriffee')
    expect(key('Robo')).toBe('robo')
    // Case-insensitive and trimmed: `products.roastery` is free admin text.
    expect(key('goriffee')).toBe('goriffee')
    expect(key('GORIFFEE')).toBe('goriffee')
    expect(key('  Robo  ')).toBe('robo')

    // ⚠ ANCHORED. „Robo Coffee" is somebody else, and a substring match would put
    // this library's description of one man's kitchen on their product.
    expect(key('Robo Coffee')).toBeNull()
    expect(key('Not Goriffee')).toBeNull()
    expect(key('Goriffee s.r.o.')).toBeNull()

    // The unknown roastery — the ORDINARY case, not an error (the admin types the
    // column as free text). `null`, and the CALLER supplies today's `acc-o`.
    expect(key('Foo')).toBeNull()
    expect(key('')).toBeNull()
    expect(key('   ')).toBeNull()

    // Type-safe: `products.roastery` is nullable, so these arrive on every product
    // that has none. Nothing may throw and nothing may match.
    expect(key(null)).toBeNull()
    expect(key(undefined)).toBeNull()
    expect(key(42)).toBeNull()
    expect(key({})).toBeNull()
    expect(key([])).toBeNull()
    expect(() => lib.roasterFor(Symbol('robo')), 'a Symbol must not take a product grid down')
      .not.toThrow()
  })

  test('⚠ the match regexes are STATELESS — a `/g/` flag would answer differently every other call', () => {
    // A global regex carries `lastIndex` between `.test()` calls, so the SECOND card
    // in a grid of Robo products would get no popover. Asserted as the behaviour, not
    // as the flag, plus the flag itself so the cause is named.
    for (const r of lib.ROASTERS) expect(r.match.global, `${r.key} is not global`).toBe(false)
    expect(lib.roasterFor('Robo')?.key).toBe('robo')
    expect(lib.roasterFor('Robo')?.key, 'and again, from the same regex object').toBe('robo')
    expect(lib.roasterFor('Robo')?.key).toBe('robo')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. „KTO SME A ODKIAĽ JE KÁVA" — the cards ARE the library (§UC-PI-012 item 5)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T8 · 18 §UC-PI-012 item 5 — who we are', () => {
  test('the two cards carry the library\'s labels, classes and texts', async ({ page }) => {
    test.skip(!HAS_LIB, NEEDS_SRC)
    const lib = await import(pathToFileURL(ROASTERS_LIB).href)

    const friend = await makeFriend('Roasters')
    await signIn(page, friend)
    await stubBalance(page)
    await stubPickup(page, [])
    await stubCycles(page, [cycleRow({ n: 3 })])
    await open(page)

    await expect(roasterCards(page)).toHaveCount(lib.ROASTERS.length)
    for (const [i, roaster] of lib.ROASTERS.entries()) {
      const card = roasterCards(page).nth(i)
      await expect(card.locator('.badge')).toHaveText(roaster.label)
      // ⚠ EQUAL to the module's own export — not „contains something about roasting".
      // The whole point of §UC-PI-014 is that this page and the product badge cannot
      // drift, and only an equality can say so.
      await expect(card.locator('.sub')).toHaveText(roaster.text)
      const cls = (await card.locator('.badge').getAttribute('class')).split(/\s+/)
      expect(cls.includes('acc-o'), `${roaster.label} badge class`).toBe(roaster.badgeClass === 'acc-o')
    }

    // The origin paragraph above them (§UC-PI-012 item 5's prototype placeholder).
    await expect(explainer(page)).toContainText('Nie je to obchod — je to okruh známych a známych ich známych, len na pozvánku.')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. „AKO SA KU KÁVE DOSTANETE" (§UC-PI-012 item 4)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T8 · 18 §UC-PI-012 item 4 — the three ways', () => {
  test('the three ways, in the ty-form — the pickup row is static PO copy', async ({ page }) => {
    const friend = await makeFriend('Ways')
    await signIn(page, friend)
    await stubBalance(page)
    // Points ARE on offer — so the static sentence below is not the empty-feed
    // fallback in disguise, and a name reaching the page would be a real regression.
    const asked = stubPickup(page, [
      { id: 1, name: 'Tesla', address: 'Ilkovičova 3', active: 1 },
      { id: 2, name: 'Fontána', address: null, active: 1 },
    ])
    await stubCycles(page, [cycleRow({ n: 4 })])
    await open(page)

    await expect(explainer(page).locator('.field-lbl', { hasText: 'Ako sa ku káve dostaneš' })).toHaveCount(1)
    await expect(ways(page)).toHaveCount(3)
    await expect(ways(page).nth(0)).toContainText('Odberné miesto v Bratislave')
    await expect(page.getByTestId('explainer-pickup-line')).toHaveText(
      'Ak si z Petržalky, alebo v okolí Legovej práce, môžem ti kávu doniesť cestou. Ak si tu nový/á, '
      + 'over si vopred, či mám kapacitu doručovať kam potrebuješ. Stále však môžeš počítať s donáškou cez Packetu.')
    await expect(ways(page).nth(0).locator('.badge')).toHaveText('zdarma')
    await expect(ways(page).nth(1)).toContainText('Objednávaš cez odkaz od priateľa? Kávu prevezme on/ona a odovzdá ti ju.')
    await expect(ways(page).nth(1).locator('.badge')).toHaveText('zdarma')
    await expect(ways(page).nth(2)).toContainText(
      'Nie si z Bratislavy? Objednaj si a nechaj poslať cez Packetu — na ľubovoľný Z-BOX alebo výdajné miesto.')

    await expect(explainer(page)).not.toContainText('Tesla')
    await expect(explainer(page)).not.toContainText('Fontána')
    expect(asked, 'the explainer no longer asks the pickup feed').toEqual([])
  })

  test('⚠ ty-form: no vy-form verb survives on the page', async ({ page }) => {
    const friend = await makeFriend('TyForm')
    await signIn(page, friend)
    await stubBalance(page)
    await stubPickup(page, [])
    await stubCycles(page, [cycleRow({ n: 5 })])
    await open(page)

    // The PO copy pass 2026-09-29 moved THIS page (and only this page) to the ty-form.
    // Non-vacuity: the page rendered its phases and its ways first.
    await expect(phases(page)).toHaveCount(6)
    await expect(ways(page)).toHaveCount(3)
    const text = await explainer(page).innerText()
    for (const vy of ['môžete', 'dozviete', 'Naklikáte', 'odošlete', 'Vyzdvihnete', 'dostanete',
      'Objednávate', 'Nie ste', 'Objednajte', 'nechajte', 'Zaplatíte', 'napíšte', 'Vyberáte', ' vám ']) {
      expect(text.includes(vy), `vy-form „${vy.trim()}" is gone`).toBe(false)
    }
  })

  test('⚠ the Packeta badge is gated on `parcel_enabled` — BOTH directions', async ({ page }) => {
    const friend = await makeFriend('Parcel')
    await signIn(page, friend)
    await stubBalance(page)
    await stubPickup(page, [])

    // OFF: no badge at all — not „zdarma", not „+0.00 EUR". Packeta being unavailable
    // is not a price of zero.
    await stubCycles(page, [cycleRow({ n: 7, status: 'open', parcel_enabled: 0, parcel_fee: 3.5 })])
    await open(page)
    await expect(ways(page).nth(2)).toContainText('Packeta')
    await expect(page.getByTestId('explainer-parcel-fee')).toHaveCount(0)

    // ON: the fee, formatted by `lib/money.js fmtEur`.
    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [cycleRow({ n: 8, status: 'open', parcel_enabled: 1, parcel_fee: 3.5 })])
    await open(page)
    await expect(page.getByTestId('explainer-parcel-fee')).toHaveText('+3.50 EUR')
  })

  test('⚠ the fee is read off `catalogCycle` when there is no current round', async ({ page }) => {
    // `resolveLanding().currentCycle` is NULL under `closed` (PI-T1 §2) — and a
    // friend with nothing to order is exactly the one reading how it works, so
    // `currentCycle` alone would hide the fee on the majority of visits.
    const friend = await makeFriend('Catalog')
    await signIn(page, friend)
    await stubBalance(page)
    await stubPickup(page, [])
    await stubCycles(page, [cycleRow({ n: 9, status: 'completed', parcel_enabled: 1, parcel_fee: 4.2 })])
    await open(page)

    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'closed')
    await expect(page.getByTestId('explainer-parcel-fee')).toHaveText('+4.20 EUR')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE REST OF THE PAGE, AND THE `asGate` SEAM (§UC-PI-012 items 1/2/6/7/8)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T8 · 18 §UC-PI-012 — heading, payment, the note, the actions', () => {
  test.beforeEach(async ({ page }) => {
    await stubBalance(page)
    await stubPickup(page, [])
  })

  test('the heading resolves as ONE name across its `<br>` and `<span>`', async ({ page }) => {
    const friend = await makeFriend('Head')
    await signIn(page, friend)
    await stubCycles(page, [cycleRow({ n: 10 })])
    await open(page)

    // §UC-PI-012's own acceptance criterion: the `<br>` and the `.p2-hl` span
    // belong to ONE heading, so one role query resolves it; a title split into
    // three sibling elements would not.
    //
    // ⚠ RECORDED SPEC DISCREPANCY, MEASURED (PI-T8). §UC-PI-012 writes the
    // criterion as `name: /Káva pod pultom, spolu\./`, i.e. as if the parts
    // concatenated cleanly. Chromium's accessible-name computation inserts a space
    // at each inline element boundary, so the real name is
    // „Káva pod pultom , spolu." — note the space BEFORE the comma. The claim the
    // spec is making is about the heading being one element, and that is what this
    // pins; the whitespace tolerance is the correction, not a weakening (the
    // `.p2-hl` assertion below is the part a rewritten heading would break).
    await expect(page.getByRole('heading', { name: /Káva\s*pod\s*pultom\s*,\s*spolu\./ })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 }).locator('.p2-hl')).toHaveText('pultom')
    await expect(explainer(page)).toContainText(
      'Podpultovka je spoločná objednávka výberovej kávy pre okruh priateľov.')
  })

  test('⚠ „(PayMe)" STAYS in „Ako platím" — 15 shipped it deliberately', async ({ page }) => {
    const friend = await makeFriend('Pay')
    await signIn(page, friend)
    await stubCycles(page, [cycleRow({ n: 11 })])
    await open(page)

    // It reads redundant beside „bankovú appku" and is not: PayMe.sk is the named
    // scheme module 15 built a dedicated bar for (`lib/payment-links.js paymeLink`).
    // §UC-PI-012 item 6's `OPEN:` („hide it until 15 ships") resolved to KEEP.
    await expect(explainer(page)).toContainText(
      'Po zabalení dostaneš sumu a QR kód. Zaplatíš jedným klepnutím cez Revolut alebo bankovú appku (PayMe), alebo prevodom na účet. Bez hotovosti.')
    // The two emphasised scheme names really are `<b>`, not prose.
    await expect(explainer(page).locator('b', { hasText: 'Revolut' })).toHaveCount(1)
  })

  test('the personal note is signed „— Lego" and is hardcoded, not a setting', async ({ page }) => {
    const friend = await makeFriend('Note')
    await signIn(page, friend)
    await stubCycles(page, [cycleRow({ n: 12 })])
    await open(page)

    const note = page.getByTestId('explainer-note')
    await expect(note).toContainText(
      '„Podpultovku robím vo voľnom čase pre kamarátov a kamarátov kamarátov. Ak čokoľvek nesedí, napíš mi na WhatsApp a určite doriešime.“')
    await expect(note.locator('b')).toHaveText('— Lego')
    await expect(note.locator('[aria-hidden="true"]')).toHaveText('L')
    // ⚠ NOT the signed-in friend's name, and not an admin setting: the voice is the
    // PO's own. A fixture friend called „PI8 Note …" is on screen elsewhere, so this
    // absence is not vacuous.
    await expect(note).not.toContainText(friend.name)
  })

  test('from the MENU the action is „Späť na ponuku", with no checkbox, and it goes home', async ({ page }) => {
    const friend = await makeFriend('Back')
    await signIn(page, friend)
    await stubCycles(page, [cycleRow({ n: 13, status: 'open' })])
    await open(page, '/')
    await menuGo(page, 'Ako to funguje')
    await expect(page).toHaveURL(/\/ako-to-funguje$/)

    // §UC-PI-012 item 8: „When opened from the menu or the closed modal: the button
    // only". The gate's checkbox is PI-T9's, and offering it here would ask a friend
    // browsing the help page to suppress something they navigated to on purpose.
    await expect(page.getByTestId('explainer-done')).toHaveText('Späť na ponuku')
    await expect(explainer(page).getByRole('checkbox')).toHaveCount(0)

    await page.getByTestId('explainer-done').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'shop')
  })

  test('⚠ the SEAM: `asGate` exists, defaults false, and PI-T9 flips it at the mount', () => {
    test.skip(!HAS_SRC, NEEDS_SRC)
    // The seam's SHAPE — the half PI-T9 was told not to have to rewrite, and did not.
    const view = assertReadable('components/PortalExplainer.vue',
      ['asGate', 'Rozumiem, idem na ponuku', 'Späť na ponuku', 'done'])
    expect(view, 'the prop exists and defaults to false')
      .toMatch(/asGate:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/)
    expect(view, 'the checkbox is pre-ticked (18 resolved conflict 3)').toMatch(/hide\s*=\s*ref\(true\)/)
    expect(view, 'both labels live on the one button').toContain("asGate ? 'Rozumiem, idem na ponuku' : 'Späť na ponuku'")
    expect(view, 'the gate\'s decision leaves as a payload, not as a second ref').toContain("emit('done', { hide: hide.value })")

    // ⚠⚠ SUPERSEDED IN PLACE BY PI-T9 (§UC-PI-013), not deleted, because the
    // ~~claim~~ it replaces is the interesting part of the history. PI-T8 asserted
    // „the session passes NO `as-gate`", which was then what made the menu-mode
    // assertion above a property of the app rather than of a prop default. PI-T9 was
    // handed that assertion to FLIP DELIBERATELY: the mount now binds
    // `:as-gate="explainerGate"`, a ref that is true only for a first login.
    //
    // What replaces the absence claim is the SAME property, asserted one level up —
    // the flag is a REF seeded once from the handshake, never a computed over
    // `props.entry`, because it has to stop being true the moment the gate is
    // answered (a drawer re-entry in the same session must show no checkbox). That is
    // now pinned behaviourally in §9 as well; this is the source half.
    const session = assertReadable('views/FriendPortalSession.vue',
      ['PortalExplainer', 'explainerParcelEnabled', 'onExplainerDone'])
    expect(session.match(/<PortalExplainer\b/g), 'exactly ONE mount').toHaveLength(1)
    expect(session, 'the gate flag is bound at that one mount (PI-T9)').toContain(':as-gate="explainerGate"')
    expect(session, 'seeded ONCE from the handshake, as a ref — never a computed')
      .toMatch(/const\s+explainerGate\s*=\s*ref\(!!props\.entry\?\.explainerPending\)/)
    expect(session, 'and it is lowered before the write branch can run twice')
      .toMatch(/explainerGate\.value\s*=\s*false/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE ROASTER POPOVER ON A PRODUCT CARD (§UC-PI-014)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T8 · 18 §UC-PI-014 — the product card badge', () => {
  let friend = null
  let cycle = null

  test.beforeAll(async () => {
    friend = await makeFriend('Badge')
    cycle = await makeCycle('Badge')
    await addProduct(cycle.id, { name: `PI8 Robo Bean ${uniq}`, purpose: 'Espresso', price_250g: 9, roastery: 'Robo' })
    await addProduct(cycle.id, { name: `PI8 Gori Bean ${uniq}`, purpose: 'Espresso', price_250g: 8, roastery: 'Goriffee' })
    await addProduct(cycle.id, { name: `PI8 Foo Bean ${uniq}`, purpose: 'Espresso', price_250g: 7, roastery: 'Foo Roasters' })
  })

  /** The landing IS the order screen (§UC-PI-005), so `/` mounts the real grid. */
  async function grid(page) {
    await signIn(page, friend)
    await stubBalance(page)
    const served = page.waitForResponse((r) => r.url().includes('/api/friends/cycles'), { timeout: TIMEOUT })
    await page.goto('/')
    await served
    await expectLanding(page)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'open')
  }

  const cardFor = (page, name) => page.getByTestId('product-card').filter({ hasText: name })
  const roasteryBadge = (page, name) => cardFor(page, name).locator('.badge').last()

  test('„Robo" ⇒ `acc-o`, a button, and the library\'s text in ONE modal', async ({ page }) => {
    test.skip(!HAS_LIB, NEEDS_SRC)
    const lib = await import(pathToFileURL(ROASTERS_LIB).href)
    await grid(page)

    const badge = roasteryBadge(page, `PI8 Robo Bean ${uniq}`)
    await expect(badge).toHaveText('Robo')
    expect((await badge.getAttribute('class')).split(/\s+/)).toContain('acc-o')
    await expect(badge).toHaveAttribute('role', 'button')
    await expect(badge).toHaveAttribute('tabindex', '0')

    await badge.click()
    const modal = page.getByTestId('roaster-modal')
    await expect(modal.locator('.m-title')).toHaveText('Robo')
    await expect(modal.locator('.m-body')).toHaveText(lib.ROASTERS[1].text)
    // ⚠ ONE instance, `v-if`-mounted: a modal per card would mean one dialog per
    // product and a scrim swallowing every click on the grid.
    await expect(page.getByTestId('roaster-modal')).toHaveCount(1)

    await modal.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByTestId('roaster-modal')).toHaveCount(0)
  })

  test('„Goriffee" ⇒ PLAIN badge, still a button, its own text', async ({ page }) => {
    test.skip(!HAS_LIB, NEEDS_SRC)
    const lib = await import(pathToFileURL(ROASTERS_LIB).href)
    await grid(page)

    const badge = roasteryBadge(page, `PI8 Gori Bean ${uniq}`)
    await expect(badge).toHaveText('Goriffee')
    // ⚠ SUPERSEDES the shipped „the roastery badge is always `acc-o`" claim
    // (`order-product-card.spec.js`, retargeted in this commit): §UC-PI-014 gives
    // Goriffee the plain badge and keeps `acc-o` for Robo and for the unknowns.
    expect((await badge.getAttribute('class')).split(/\s+/)).not.toContain('acc-o')
    await expect(badge).toHaveAttribute('role', 'button')

    // Keyboard too — the affordance it announces has to work.
    await badge.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('roaster-modal').locator('.m-title')).toHaveText('Goriffee')
    await expect(page.getByTestId('roaster-modal').locator('.m-body')).toHaveText(lib.ROASTERS[0].text)
  })

  test('⚠ an UNKNOWN roastery keeps today\'s `acc-o` and announces NOTHING', async ({ page }) => {
    await grid(page)

    const badge = roasteryBadge(page, `PI8 Foo Bean ${uniq}`)
    await expect(badge).toHaveText('Foo Roasters')
    // The admin types `products.roastery` as free text, so this is the ORDINARY case.
    expect((await badge.getAttribute('class')).split(/\s+/)).toContain('acc-o')
    await expect(badge).not.toHaveAttribute('role', 'button')
    await expect(badge).not.toHaveAttribute('tabindex', '0')

    // ⚠ AND THE HANDLER REFUSES IT TOO. A missing `role` does not stop a DISPATCHED
    // click reaching the handler (CLAUDE.md §Frontend), so the JS guard is the real
    // one — a badge that announced itself as a button and did nothing would be worse
    // than a plain span, and one that opened an EMPTY modal worse still.
    await badge.dispatchEvent('click')
    await expect(page.getByTestId('roaster-modal')).toHaveCount(0)
    // Non-vacuity: a sibling card's badge still opens one on the same page.
    await roasteryBadge(page, `PI8 Robo Bean ${uniq}`).click()
    await expect(page.getByTestId('roaster-modal')).toHaveCount(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. ⚠ THE NAMED NON-CONSUMER — admin invariance, MEASURED
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T8 · 18 §UC-PI-014 — `lib/roasters.js` has one home and one boundary', () => {
  test.skip(!HAS_SRC, NEEDS_SRC)

  /** Every `.vue`/`.js`/`.ts` file under `frontend/src`, relative paths. */
  function sourceFiles(dir = SRC, out = []) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) sourceFiles(full, out)
      else if (/\.(vue|js|ts)$/.test(entry)) out.push(relative(SRC, full))
    }
    return out
  }

  test('the importer set is exactly the friend surfaces — no admin file reads it', () => {
    const files = sourceFiles()
    // Non-vacuity first: a sweep that found nothing would pass every claim below.
    expect(files.length, 'the source tree was walked').toBeGreaterThan(40)
    expect(files, 'and the admin skin really is in it').toContain(join('views', 'AdminFriends.vue'))

    // ⚠⚠ THE EXTENSION AND `import()` FORMS ARE THE POINT, not pedantry — widened at the
    // PI-T8 review. The first version matched only `from '…/lib/roasters'`, so
    // `from '@/lib/roasters.js'` and `await import('…/lib/roasters')` walked straight past
    // it. That is not hypothetical: `views/CycleDetail.vue:25` — an ADMIN view — already
    // imports `'../lib/cycle-stages.js'` WITH the extension, so an admin import written in
    // this repo's own prevailing style would have evaded the guard entirely, and the
    // mutation that „proved" it only reddened because it happened to be typed without one.
    // A boundary guard that misses the house style is not a guard.
    const IMPORTS_ROASTERS = /(?:from|import\()\s*['"][^'"]*lib\/roasters(?:\.js)?['"]/
    const importers = files.filter((rel) => IMPORTS_ROASTERS.test(readFileSync(join(SRC, rel), 'utf8')))
    // GL-T4 (19 §UC-GL-007) added the THIRD named consumer, `GuestRoastersLine.vue` —
    // added to the exact set, the sweep itself unchanged (never loosened).
    expect(importers.sort(), 'the two consumers PI-T8 ships + GL-T4\'s GuestRoastersLine.vue')
      .toEqual([
        join('components', 'PortalExplainer.vue'),
        join('views', 'FriendOrder.vue'),
        join('components', 'GuestRoastersLine.vue'),
      ].sort())

    // …stated as the BOUNDARY as well as the list, so a third friend-surface consumer
    // (GL-T4's guest line) does not have to weaken the rule to land: no admin file,
    // ever. Roastery administration keeps its own data — the admin must go on being
    // able to name a roastery this library has never heard of.
    // ⚠ ALLOW-LIST, not a deny-list — inverted at the PI-T8 review. Recognising admin as
    // „`views/Admin*` or `components/(ui|analytics)/`" misses the admin surfaces that do not
    // start with `Admin`: §UC-PI-019 item 18 names `CycleDetail.vue` and `Distribution.vue`
    // outright, and `LiveCycleDashboard`, `CoffeeAnalytics`, `BakeryAnalytics` and
    // `FriendDetail` are admin too. A deny-list has to be kept complete forever; an
    // allow-list fails closed the first time an unexpected file imports the lib, which is
    // exactly the scenario this loop exists for. (Today the set-equality above already
    // covers it — this half only becomes load-bearing when GL-T4 extends the list.)
    const PERMITTED = /^(components\/PortalExplainer\.vue|views\/FriendOrder\.vue|components\/Guest[A-Za-z]*\.vue|views\/Guest[A-Za-z]*\.vue)$/
    for (const rel of importers) {
      expect(rel, `${rel} is not on the permitted friend/guest list — no admin file may import lib/roasters.js`)
        .toMatch(PERMITTED)
    }
  })

  test('the six new glyphs live in the ONE icon module', () => {
    const icons = assertReadable('components/neo/icons.js', ['ICONS', 'pause', 'bell', 'cup', 'truck', 'box', 'hand'])
    for (const name of ['pause', 'bell', 'cup', 'truck', 'box', 'hand']) {
      expect(icons, `${name} is declared in icons.js`).toMatch(new RegExp(`\\n\\s{2}${name}:\\s*\\{`))
    }
    // ⚠ ONE icon source for friend/guest surfaces (RD-DS-2): no second module, no
    // icon font, no package. The component renders `NeoIcon`, never an inline `<svg>`.
    const view = code('components/PortalExplainer.vue')
    expect(view, 'the explainer draws no SVG of its own').not.toContain('<svg')
    expect(view).toContain('NeoIcon')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 8. 320 px — zero horizontal overflow
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T8 · 18 §UC-PI-012 — the phone floor', () => {
  test('the page does not scroll the document sideways at 320px', async ({ page }) => {
    const friend = await makeFriend('Narrow')
    await signIn(page, friend)
    await stubBalance(page)
    // ~~A 120-char unbreakable location name~~ — the pickup row no longer renders admin
    // data (PO copy pass 2026-09-29), so the floor is measured on the static page with
    // every conditional (the Packeta fee badge) switched ON.
    await stubPickup(page, [])
    await stubCycles(page, [cycleRow({ n: 14, status: 'open', parcel_enabled: 1, parcel_fee: 3.5 })])
    await page.setViewportSize({ width: 320, height: 720 })
    await open(page)

    await expect(page.getByTestId('explainer-parcel-fee')).toBeVisible()
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
    }))
    expect(overflow.doc, `no horizontal overflow at 320px (${JSON.stringify(overflow)})`)
      .toBeLessThanOrEqual(overflow.win)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 9. PI-T9 · 18 §UC-PI-013 — THE FIRST-LOGIN GATE
//
// ⚠⚠ THE PROPERTY THIS BLOCK PROTECTS FIRST, and it is a SUITE-WIDE one: the gate
// fires on a LOGIN and on nothing else. A session RESTORE — which is how ~32 spec
// files sign a friend in, by writing `gorifi_friend_auth` into localStorage — must
// never reach the explainer, or every one of those files starts measuring a screen it
// did not ask for. §UC-PI-013 states that as "a session restore is not a login"; the
// „reload" test below is what makes it a red run instead of a sentence.
//
// ⚠ THE SECOND PROPERTY: the shared password resolves NO identity
// (`requireFriendOwner` yields `friendId: null` in legacy mode), so the write is a
// 401 there rather than a stamp of whoever the URL names — the GA-T5 rule. The
// refusal test READS THE ROW BACK, because a route that 401s and writes anyway looks
// identical from the status code.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T9 · 18 §UC-PI-013 — the first-login explainer gate', () => {
  /** The MODERN login card, without touching the deployment's `auth_mode`. */
  async function modernCard(page) {
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'modern' } }))
  }

  /** A fresh document with no stored session, so the next entry is a real LOGIN. */
  async function freshVisit(page) {
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/')
  }

  async function uiLogin(page, friend) {
    await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
    await page.getByLabel(/^heslo$/i).fill(friend.password)
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
  }

  /** Every `POST …/explainer-seen` this page issued, in order. */
  function countStamps(page, friendId) {
    const seen = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes(`/api/friends/${friendId}/explainer-seen`)) seen.push(r.url())
    })
    return seen
  }

  /** `explainer_seen_at` as the owner's own profile endpoint publishes it. */
  async function storedStamp(friend) {
    const res = await ctx.get(`/api/friends/${friend.id}/profile`, {
      headers: { Authorization: `Bearer ${friend.token}` }, timeout: TIMEOUT,
    })
    expect(res.status(), 'profile read').toBe(200)
    return (await res.json()).explainer_seen_at ?? null
  }

  async function gateFixture(page, label, opts) {
    const friend = await makeFriend(label, opts)
    await modernCard(page)
    await stubBalance(page)
    await stubCycles(page, [cycleRow({ n: 20, status: 'open' })])
    expect(await storedStamp(friend), 'the fixture starts UNACKNOWLEDGED').toBeNull()
    return friend
  }

  test('a fresh friend\'s LOGIN lands on the explainer, with the pre-ticked checkbox', async ({ page }) => {
    const friend = await gateFixture(page, 'GateFresh')
    await freshVisit(page)
    await uiLogin(page, friend)

    await expectLanding(page)
    await expect(page).toHaveURL(/\/ako-to-funguje$/)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'explainer')

    // §UC-PI-012 item 8, gate mode: the checkbox row AND the gate's own button label.
    const box = explainer(page).getByRole('checkbox', { name: 'Už mi to neukazovať' })
    await expect(box).toHaveCount(1)
    await expect(box, 'PRE-ticked — 18 resolved conflict 3').toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('explainer-done')).toHaveText('Rozumiem, idem na ponuku')

    // ⚠ THE DISCRIMINATING HALF: it is the EXPLAINER the friend met, not the shop
    // behind a checkbox. Without this the test passes against a build that renders
    // the landing and the gate's chrome at the same time.
    await expect(explainer(page)).toBeVisible()
    await expect(phases(page)).toHaveCount(6)
  })

  test('„Rozumiem" with the box TICKED stamps once, goes home, and the NEXT login skips the gate', async ({ page }) => {
    const friend = await gateFixture(page, 'GateTick')
    const stamps = countStamps(page, friend.id)
    await freshVisit(page)
    await uiLogin(page, friend)
    await expect(page).toHaveURL(/\/ako-to-funguje$/)

    const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/explainer-seen'), { timeout: TIMEOUT })
    await page.getByTestId('explainer-done').click()
    await posted
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'shop')

    expect(stamps, 'exactly ONE stamp, for THIS friend').toHaveLength(1)
    const stored = await storedStamp(friend)
    expect(stored, 'and the column is really written').not.toBeNull()

    // §UC-PI-013's acceptance criterion: „second login ⇒ straight to `/`".
    await freshVisit(page)
    await uiLogin(page, friend)
    await expectLanding(page)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'shop')
    expect(stamps, 'and the second login writes nothing at all').toHaveLength(1)
  })

  test('„Rozumiem" UNTICKED writes nothing, and the gate comes back at the next login', async ({ page }) => {
    const friend = await gateFixture(page, 'GateUntick')
    const stamps = countStamps(page, friend.id)
    await freshVisit(page)
    await uiLogin(page, friend)
    await expect(page).toHaveURL(/\/ako-to-funguje$/)

    // Untick through the label's own text zone — the three-zone row the component
    // copied from `FriendPortal.vue`; clicking it must toggle exactly once.
    await explainer(page).getByText('Už mi to neukazovať', { exact: true }).click()
    await expect(explainer(page).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false')

    await page.getByTestId('explainer-done').click()
    await expect(page).toHaveURL(/\/$/)
    expect(stamps, 'no write — the friend asked to be shown it again').toHaveLength(0)
    expect(await storedStamp(friend), 'and the column is untouched').toBeNull()

    // ⚠ NON-VACUITY for the absence above: the SAME fixture, one login later, still
    // meets the gate. An implementation that simply never opened it would pass the
    // „no POST" half and fail here.
    await freshVisit(page)
    await uiLogin(page, friend)
    await expect(page).toHaveURL(/\/ako-to-funguje$/)
    await expect(page.getByTestId('explainer-done')).toHaveText('Rozumiem, idem na ponuku')
  })

  test('⚠ a RESTORE is not a login: a reload with the stamp still NULL lands on the shop', async ({ page }) => {
    const friend = await gateFixture(page, 'GateRestore')
    const stamps = countStamps(page, friend.id)

    // The ~32-spec-file shape: the stored session, restored, with nothing acknowledged.
    await signIn(page, friend)
    await open(page, '/')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'shop')
    await expect(explainer(page)).toHaveCount(0)

    // And a second document — a genuine reload — behaves the same way.
    await open(page, '/')
    await expect(page).toHaveURL(/\/$/)
    expect(stamps, 'a restore writes nothing either').toHaveLength(0)
    expect(await storedStamp(friend), 'and the column stays NULL').toBeNull()

    // ⚠ The other half of the same rule: reached from the MENU in that very session
    // the page is the plain explainer — no checkbox, no gate label — because the flag
    // came from a handshake that was not a login.
    await menuGo(page, 'Ako to funguje')
    await expect(page).toHaveURL(/\/ako-to-funguje$/)
    await expect(page.getByTestId('explainer-done')).toHaveText('Späť na ponuku')
    await expect(explainer(page).getByRole('checkbox')).toHaveCount(0)
  })

  test('⚠ the gate is ONE-SHOT: re-entering from the drawer in the same session shows no checkbox', async ({ page }) => {
    const friend = await gateFixture(page, 'GateOnce')
    const stamps = countStamps(page, friend.id)
    await freshVisit(page)
    await uiLogin(page, friend)
    await expect(page).toHaveURL(/\/ako-to-funguje$/)

    // Leave the gate WITHOUT answering it — the appbar's back chevron, which
    // §UC-PI-003 puts where the hamburger is on the other three views.
    await page.locator('.appbar [aria-label="Späť"]').click()
    await expect(page).toHaveURL(/\/$/)
    expect(stamps, 'the chevron answers nothing, so it writes nothing').toHaveLength(0)

    // Back in from the drawer: the SAME session, now the menu-mode page.
    await menuGo(page, 'Ako to funguje')
    await expect(page.getByTestId('explainer-done')).toHaveText('Späť na ponuku')
    await expect(explainer(page).getByRole('checkbox')).toHaveCount(0)
    await page.getByTestId('explainer-done').click()
    await expect(page).toHaveURL(/\/$/)
    // ⚠ THE POINT: `PortalExplainer` emits `{ hide: true }` in BOTH modes (one payload
    // shape), so a handler that read the payload without checking the gate flag would
    // stamp HERE — silently retiring an explainer the friend never acknowledged.
    expect(stamps, 'a menu-opened explainer never writes').toHaveLength(0)
    expect(await storedStamp(friend), 'the column is still NULL').toBeNull()
  })

  test('precedence: the forced password change is met FIRST, with the explainer underneath', async ({ page }) => {
    const friend = await gateFixture(page, 'GateForced', { keepForcedChange: true })
    await freshVisit(page)
    await uiLogin(page, friend)

    // §UC-PI-013: „The forced-password gate (03 UC-FL-012) … takes precedence: the
    // explainer view waits underneath". Both halves, because either alone is
    // satisfied by the wrong build — the modal alone by a version that never routed,
    // the URL alone by one that skipped the forced gate.
    const gate = page.getByTestId('forced-password-change')
    await expect(gate).toBeVisible()
    await expect(page).toHaveURL(/\/ako-to-funguje$/)

    await gate.getByLabel(/^nové heslo$/i).fill('novéHeslo123')
    await gate.getByLabel(/^potvrdiť nové heslo$/i).fill('novéHeslo123')
    await gate.getByRole('button', { name: 'Nastaviť heslo a pokračovať' }).click()
    await expect(gate).toHaveCount(0)

    // …and what is underneath is the gate-mode explainer, not the shop.
    await expect(page).toHaveURL(/\/ako-to-funguje$/)
    await expect(page.getByTestId('explainer-done')).toHaveText('Rozumiem, idem na ponuku')
  })

  // ── the route itself ───────────────────────────────────────────────────────

  test('the stamp is IDEMPOTENT — a second POST returns the same timestamp', async ({ page }) => {
    const friend = await makeFriend('GateIdem')
    const auth = { Authorization: `Bearer ${friend.token}` }

    const first = await ctx.post(`/api/friends/${friend.id}/explainer-seen`, { headers: auth, timeout: TIMEOUT })
    expect(first.status()).toBe(200)
    const one = (await first.json()).explainer_seen_at
    expect(one, 'the route answers the stored value').toBeTruthy()

    // ⚠ `datetime('now')` is SECOND-resolution, so two calls in the same second would
    // agree even without `COALESCE`. Wait past the boundary, or this proves nothing.
    await page.waitForTimeout(1200)

    const second = await ctx.post(`/api/friends/${friend.id}/explainer-seen`, { headers: auth, timeout: TIMEOUT })
    expect(second.status()).toBe(200)
    expect((await second.json()).explainer_seen_at, 'COALESCE — never re-stamped').toBe(one)
    expect(await storedStamp(friend), 'and the row agrees').toBe(one)
  })

  test('⚠ shared-password auth resolves NO identity: 401, and NOTHING is written', async () => {
    const friend = await makeFriend('GateShared')
    const victim = await makeFriend('GateVictim')

    // The legacy window's credential. `requireFriendOwner` resolves `friendId: null`
    // for it, so ownership is meaningless — the route must refuse rather than stamp
    // whoever the URL names (GA-T5).
    const res = await ctx.post(`/api/friends/${victim.id}/explainer-seen`, {
      headers: { 'X-Friends-Password': FRIENDS_PASSWORD }, timeout: TIMEOUT,
    })
    expect(res.status(), 'the shared password is not an identity').toBe(401)
    expect(await storedStamp(victim), 'READ BACK — a 401 that wrote anyway looks identical').toBeNull()

    // Non-vacuity: the same header on the same deployment IS accepted elsewhere, so
    // the refusal is about identity and not about a mis-typed header.
    const balance = await ctx.get(`/api/friends/${victim.id}/balance`, {
      headers: { 'X-Friends-Password': FRIENDS_PASSWORD }, timeout: TIMEOUT,
    })
    expect(balance.status(), 'the shared password still authenticates a READ').toBe(200)

    // And a friend's own session may not stamp SOMEBODY ELSE (SEC-A1 IDOR).
    const cross = await ctx.post(`/api/friends/${victim.id}/explainer-seen`, {
      headers: { Authorization: `Bearer ${friend.token}` }, timeout: TIMEOUT,
    })
    expect(cross.status(), 'another friend\'s session is a 403').toBe(403)
    expect(await storedStamp(victim), 'still nothing written').toBeNull()
  })

  test('an anonymous POST is 401 and an unknown id is 403 — ownership is checked first', async () => {
    const friend = await makeFriend('GateUnknown')

    const anon = await ctx.post(`/api/friends/${friend.id}/explainer-seen`, { timeout: TIMEOUT })
    expect(anon.status(), 'no credential at all').toBe(401)
    expect(await storedStamp(friend), 'and nothing was written').toBeNull()

    // A friend's own token against a row that does not exist — the guard passes
    // (the ids match) and the lookup is what refuses, which is the only way to reach
    // the 404 at all.
    const gone = await ctx.post('/api/friends/9999999/explainer-seen', {
      headers: { Authorization: `Bearer ${friend.token}` }, timeout: TIMEOUT,
    })
    expect(gone.status(), 'ownership is checked first, so this is a 403 not a 404').toBe(403)
  })

  test('the field rides every LOGIN payload, and a deactivated friend is refused', async () => {
    const friend = await makeFriend('GatePayload')

    // 1 of 4 — the username branch.
    const personal = await ctx.post('/api/friends/auth', {
      data: { username: friend.username, password: friend.password }, timeout: TIMEOUT,
    })
    expect(personal.status()).toBe(200)
    const personalBody = await personal.json()
    expect(personalBody.friend, 'the field is PRESENT and explicitly null').toHaveProperty('explainer_seen_at', null)

    // 2 of 4 — the legacy shared-password branch, which mints a per-friend session too.
    const shared = await ctx.post('/api/friends/auth', {
      data: { password: FRIENDS_PASSWORD, friendId: friend.id }, timeout: TIMEOUT,
    })
    expect(shared.status()).toBe(200)
    expect((await shared.json()).friend).toHaveProperty('explainer_seen_at', null)

    // …and it carries the REAL value once stamped, not a hardcoded null.
    expect((await ctx.post(`/api/friends/${friend.id}/explainer-seen`, {
      headers: { Authorization: `Bearer ${personalBody.token}` }, timeout: TIMEOUT,
    })).status()).toBe(200)
    const after = await ctx.post('/api/friends/auth', {
      data: { username: friend.username, password: friend.password }, timeout: TIMEOUT,
    })
    expect((await after.json()).friend.explainer_seen_at, 'the stamped value rides the next login').toBeTruthy()

    // ⚠ DEACTIVATING THROUGH THE API IS A 401, NOT THE 404 — and that is worth pinning
    // rather than working around, because it is the honest answer: the admin PATCH
    // invalidates the friend's sessions, so the Bearer token dies before
    // `requireFriendOwner` can resolve anybody. The route's `active = 1` predicate is
    // therefore UNREACHABLE on this path, exactly as CS-T1 found for `markCycleReady`'s
    // `stage IS NULL` row.
    expect((await admin(`/api/friends/${friend.id}`, { method: 'patch', data: { active: 0 } })).status()).toBe(200)
    const viaApi = await ctx.post(`/api/friends/${friend.id}/explainer-seen`, {
      headers: { Authorization: `Bearer ${personalBody.token}` }, timeout: TIMEOUT,
    })
    expect(viaApi.status(), 'deactivation kills the session first').toBe(401)
  })

  test('⚠ the `active = 1` predicate is load-bearing — the built scenario the API cannot reach', async () => {
    const dbPath = process.env.DB_PATH
    test.skip(!dbPath, 'requires DB_PATH to deactivate a friend WITHOUT killing their session')
    const friend = await makeFriend('GateInactive')

    // The state the API refuses to produce: `active = 0` with a LIVE session. Written
    // straight into the row, the way `cycle-stages.spec.js` manufactures its
    // `stage IS NULL` locked cycle — a build-the-scenario gate, not a shortcut.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('UPDATE friends SET active = 0 WHERE id = ?').run(Number(friend.id))
    } finally {
      db.close()
    }

    const res = await ctx.post(`/api/friends/${friend.id}/explainer-seen`, {
      headers: { Authorization: `Bearer ${friend.token}` }, timeout: TIMEOUT,
    })
    expect(res.status(), 'unknown OR inactive').toBe(404)
    expect((await res.json()).error).toBe('Priateľ nebol nájdený alebo je neaktívny')

    // Non-vacuity: the SAME request against the SAME friend is a 200 once the row is
    // active again, so the 404 is about `active`, not about the id or the token.
    const db2 = new DatabaseSync(dbPath)
    try {
      db2.prepare('UPDATE friends SET active = 1 WHERE id = ?').run(Number(friend.id))
    } finally {
      db2.close()
    }
    expect((await ctx.post(`/api/friends/${friend.id}/explainer-seen`, {
      headers: { Authorization: `Bearer ${friend.token}` }, timeout: TIMEOUT,
    })).status(), 'and an active friend is stamped').toBe(200)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 10. PI-T9 · THE SEED'S OWN GUARD — the 76-friend pre-stamp, and its one exception
//
// ⚠⚠ THIS IS THE SUITE-WIDE HALF OF PI-T9, and it is the one a future reader is most
// likely to undo. `e2e/seed.mjs` step 7 stamps every friend in the gate database
// EXCEPT `E2EExplainerGate`, so that a spec logging a template friend in through the
// UI measures the screen it came for rather than the explainer. Stamping the fixture
// too — the obvious "tidy" — would leave the seed with no unacknowledged friend at
// all and nothing would say so. This test says so.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T9 · the seeded explainer state', () => {
  test('the seed stamps the circle and leaves exactly one fixture unacknowledged', async () => {
    const res = await admin('/api/friends', { method: 'get' })
    expect(res.status(), 'admin friends list').toBe(200)
    const rows = await res.json()

    const seeded = rows.find((f) => f.name === 'E2ETester')
    const fixture = rows.find((f) => f.name === 'E2EExplainerGate')
    // Target-agnostic: a deployed environment has neither of the seed's fixtures.
    test.skip(!seeded || !fixture, 'not a seeded gate database (e2e/seed.mjs has not run here)')

    expect(seeded.explainer_seen_at, 'the ordinary seeded friend is pre-stamped').toBeTruthy()
    expect(fixture.explainer_seen_at, 'the DEDICATED fixture is deliberately NULL').toBeNull()

    // ⚠ NON-VACUITY, and it is the assertion that makes the pair mean something: the
    // pre-stamp reached the TEMPLATE's 76 friends too, not just the one row the seed
    // created. `E2ETester` alone would pass against a seed that stamped exactly one.
    //
    // ⚠ SCOPED BY ID, not by name. Every other spec file creates friends of its own
    // and none of them stamps anything, so "no unstamped friend anywhere" is false by
    // construction the moment a second file has run. The gate fixture is the LAST row
    // the seed writes, so `id < fixture.id` is exactly "existed when the seed ran".
    const preExisting = rows.filter((f) => f.id < fixture.id)
    expect(preExisting.length, 'the template really is a ~76-friend snapshot').toBeGreaterThan(20)
    const unstamped = preExisting.filter((f) => !f.explainer_seen_at).map((f) => f.name)
    expect(unstamped, 'every friend that existed when the seed ran is stamped').toEqual([])
  })
})
