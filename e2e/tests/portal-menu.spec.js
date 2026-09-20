import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'
import {
  expectLanding, expectNoLanding, drawer, openMenu, menuGo, logout, dismissLandingState,
} from '../helpers/portal.js'
import { makeAdmin } from '../helpers/admin.js'

// PI-T2 — 18 §UC-PI-004, the hamburger drawer (`NeoDrawer.vue`), and
// §UC-PI-019 item 17's `portal-menu.spec.js`.
//
// ⚠ WHAT IS DELIBERATELY NOT HERE, so nobody reads a gap as a decision:
//   · ~~ITEM 4 and item 1's „ · v košíku {suma}" clause~~ — **LANDED WITH PI-T3**,
//     in section 1b below. That section is also where §UC-PI-019 item 6 moves the
//     surviving properties of the deleted `portal-share-row.spec.js`: the colleague
//     count's copy states, the sequence guard, and the bound on the count fetch.
//
// ⚠ HERMETIC, per the RD-FL-2 idiom: this file provisions its own friends over the
// admin API and signs the browser in by seeding a REAL session token. The cycles
// payload is stubbed where a specific landing STATE is under test, and the balance
// is stubbed everywhere a money figure is asserted.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

// FUP-T27 — ONE home for the admin request path: it re-authenticates ONCE on a
// 401 instead of trusting a token the next `POST /api/admin/login` anywhere in the
// suite silently rotates out. See `helpers/admin.js`.
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
  const username = `pi2_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `PI2 ${label} ${uniq}`
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

/**
 * A REAL open cycle with real products — needed by the „ · v košíku" test, which
 * measures the landing's own cart and therefore cannot run against a stubbed
 * `GET /friends/cycles` (the embedded `FriendOrder` loads its order from the API).
 * Created last ⇒ the newest open round ⇒ the landing's round.
 */
async function makeRealCycle(label) {
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name: `PI3 Menu ${label} ${uniq}`, type: 'coffee', status: 'open' },
  })
  expect(res.status(), 'cycle create').toBe(201)
  return res.json()
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
  id: 70_000 + (over.n || 0), name: `PI2 Round ${over.n || 0}`, status: 'planned',
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

async function stubBalance(page, balance) {
  await page.route('**/api/friends/*/balance', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ balance, transactions: [] }),
  }))
}

/**
 * Load a view with a known cycles payload.
 *
 * ⚠ It WAITS for the cycles response. `cycles` starts empty on a restore, so every
 * sub-line reads its `closed` wording before the payload lands — an assertion that
 * fired early would pass for the wrong reason on every closed-state row (PI-T1 §9).
 */
async function open(page, path = '/') {
  const served = page.waitForResponse((r) => r.url().includes('/api/friends/cycles'), { timeout: TIMEOUT })
  await page.goto(path)
  await served
  await expectLanding(page)
}

/** The rows, in DOM order, as `{ label, sub, badge }`. */
async function rows(page) {
  return drawer(page).locator('.p2-mi').evaluateAll((els) => els.map((el) => ({
    label: el.querySelector('.lab')?.textContent?.trim() || '',
    sub: el.querySelector('.sub')?.textContent?.trim() || null,
    badge: el.querySelector('.badge')?.textContent?.trim() || null,
    badgeClass: el.querySelector('.badge')?.className || null,
    on: el.classList.contains('on'),
  })))
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The rows: order, labels, sub-lines, the conditional slot
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T2 · 18 §UC-PI-004 — the drawer rows', () => {
  test('seven rows on an OPEN round, six otherwise — item 4 is the only conditional one', async ({ page }) => {
    // ⚠ PI-T3 FILLED THE SLOT PI-T2 PINNED EMPTY, and this is the assertion that
    // records it. §UC-PI-004's table makes item 4 („Zdieľať s kolegami") conditional
    // on `state === 'open'` — 05 §UC-KG-002's rule that a locked or closed round
    // offers no share affordance at all — so the row set has exactly two shapes and
    // both are pinned here. A one-payload test would pass against a component that
    // rendered the row unconditionally.
    const friend = await makeFriend('Rows')
    await signIn(page, friend)
    await stubBalance(page, -12.5)
    await stubCycles(page, [cycleRow({ n: 1, status: 'open', closes_at: '2026-09-12' })])
    await open(page)

    await openMenu(page)
    expect((await rows(page)).map((r) => r.label)).toEqual([
      'Aktuálna ponuka',
      'Moje objednávky',
      'Zostatok a platby',
      'Zdieľať s kolegami',
      'Pozvať priateľa',
      'Ako to funguje',
      'Profil',
    ])

    // The same friend, a round that is not open: the row is GONE, not disabled.
    await stubCycles(page, [cycleRow({ n: 2, status: 'locked' })])
    await open(page)
    await openMenu(page)
    expect((await rows(page)).map((r) => r.label)).toEqual([
      'Aktuálna ponuka',
      'Moje objednávky',
      'Zostatok a platby',
      'Pozvať priateľa',
      'Ako to funguje',
      'Profil',
    ])
    await expect(drawer(page).getByText('Zdieľať s kolegami')).toHaveCount(0)
  })

  test('the header shows the friend\'s NAME and nothing else that identifies them', async ({ page }) => {
    // 18 resolved conflict 9 / §16: no uid, no „člen od {rok}". The prototype's
    // „{code} · člen od 2024" row is demo data and must not be ported.
    const friend = await makeFriend('Header')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await open(page)

    const menu = await openMenu(page)
    await expect(menu.getByTestId('drawer-friend-name')).toHaveText(friend.name)
    await expect(menu.locator('.p2-dh')).toContainText('Podpultovka')
    await expect(menu.locator('.p2-dh')).not.toContainText('člen od')
    // The uid is a real value on this friend's stored session, so its absence here
    // is a claim about the drawer and not about an empty string.
    const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('gorifi_friend_auth')).friendUid)
    if (uid) await expect(menu.locator('.p2-dh')).not.toContainText(uid)
  })

  test('item 1\'s sub-line follows the round: the closing DATE when open, „zatvorené" otherwise', async ({ page }) => {
    const friend = await makeFriend('Sub1')
    await signIn(page, friend)
    await stubBalance(page, 0)

    await stubCycles(page, [cycleRow({ n: 2, status: 'open', closes_at: '2026-09-12' })])
    await open(page)
    await openMenu(page)
    expect((await rows(page))[0].sub).toBe('Otvorené do 12. 9. 2026')
    await page.keyboard.press('Escape')

    // An open round with NO stored deadline drops the „do …" half rather than
    // printing „Otvorené do " with a hole in it.
    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [cycleRow({ n: 3, status: 'open', closes_at: null })])
    await open(page)
    await openMenu(page)
    expect((await rows(page))[0].sub).toBe('Objednávky sú otvorené')
    await page.keyboard.press('Escape')

    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [cycleRow({ n: 4, status: 'locked' })])
    await open(page)
    await openMenu(page)
    expect((await rows(page))[0].sub).toBe('Objednávky sú zatvorené')
  })

  test('item 2 counts the rounds the friend ORDERED in, declined, newest named', async ({ page }) => {
    const friend = await makeFriend('Sub2')
    await signIn(page, friend)
    await stubBalance(page, 0)

    // None.
    await stubCycles(page, [cycleRow({ n: 5, status: 'open' })])
    await open(page)
    await openMenu(page)
    expect((await rows(page))[1].sub).toBe('Zatiaľ žiadne')
    await page.keyboard.press('Escape')

    // ⚠ The DECLENSION and the „newest" pick are both under test, and the fixture
    // is built so neither can pass by accident: THREE ordered rounds (accusative
    // plural „objednávky", not „objednávku"/„objednávok") and a FOURTH, newest
    // round with no order of the friend's own — so „naposledy" naming it would be
    // wrong, and naming the oldest ordered one would be wrong too.
    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [
      cycleRow({ n: 6, name: 'PI2 Newest No Order', status: 'open', created_at: '2026-09-09 10:00:00' }),
      cycleRow({ n: 7, name: 'PI2 September', status: 'completed', hasOrder: true, created_at: '2026-09-08 10:00:00' }),
      cycleRow({ n: 8, name: 'PI2 August', status: 'completed', hasOrder: true, created_at: '2026-08-08 10:00:00' }),
      cycleRow({ n: 9, name: 'PI2 Júl', status: 'completed', hasOrder: true, created_at: '2026-07-08 10:00:00' }),
    ])
    await open(page)
    await openMenu(page)
    expect((await rows(page))[1].sub).toBe('3 objednávky · naposledy PI2 September')
    await page.keyboard.press('Escape')

    // …and ONE ordered round takes the singular accusative.
    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [cycleRow({ n: 10, name: 'PI2 Jediná', status: 'completed', hasOrder: true })])
    await open(page)
    // ⚠ SANCTIONED EDIT, PI-T4 (18 §UC-PI-006, immutability case (a)): a completed
    // round alone IS the CLOSED landing, which now opens its state modal by itself,
    // and the modal's scrim covers the hamburger — `openMenu()` would time out on
    // actionability instead of measuring the sub-line. The claim (item 2's singular
    // accusative) is untouched; only the way to the drawer is. ⚠ This is the ONE
    // fixture in this file that lands `closed`; every other row above is `open` or
    // `locked`, neither of which shows a modal.
    await dismissLandingState(page)
    await openMenu(page)
    expect((await rows(page))[1].sub).toBe('1 objednávku · naposledy PI2 Jediná')
  })

  test('item 3\'s badge: danger under debt, ok otherwise, and NOTHING while it loads', async ({ page }) => {
    const friend = await makeFriend('Badge')
    await signIn(page, friend)
    await stubCycles(page, [cycleRow({ n: 11, status: 'open' })])

    await stubBalance(page, -52.8)
    await open(page)
    await openMenu(page)
    let row3 = (await rows(page))[2]
    expect(row3.badge).toBe('-52.80 EUR')
    expect(row3.badgeClass).toContain('danger')
    await page.keyboard.press('Escape')

    // ⚠ The THRESHOLD, not the sign: §UC-PI-004 says `balance < -0.01` is debt, so
    // a balance that rounds to zero is NOT painted red. `-0.004` is the value that
    // separates the specified rule from a naive `balance < 0`.
    await page.unroute('**/api/friends/*/balance')
    await stubBalance(page, -0.004)
    await open(page)
    await openMenu(page)
    row3 = (await rows(page))[2]
    expect(row3.badgeClass, 'a balance that rounds to zero is not a debt').toContain('ok')
    expect(row3.badgeClass).not.toContain('danger')
    await page.keyboard.press('Escape')

    await page.unroute('**/api/friends/*/balance')
    await stubBalance(page, 4.2)
    await open(page)
    await openMenu(page)
    row3 = (await rows(page))[2]
    expect(row3.badge).toBe('4.20 EUR')
    expect(row3.badgeClass).toContain('ok')
  })

  test('⚠ a balance that never resolves shows NO badge — never a placeholder figure', async ({ page }) => {
    const friend = await makeFriend('Hang')
    await signIn(page, friend)
    await stubCycles(page, [cycleRow({ n: 12, status: 'open' })])
    // Held open for the whole test: the request is in flight and never answers.
    await page.route('**/api/friends/*/balance', () => {})
    await open(page)

    await openMenu(page)
    const row3 = (await rows(page))[2]
    expect(row3.label, 'the row itself renders').toBe('Zostatok a platby')
    expect(row3.badge, 'no money figure may be invented while the balance is unknown').toBeNull()
    // Non-vacuity: the OTHER rows' sub-lines are there, so „nothing rendered" is
    // not what this is measuring.
    expect((await rows(page))[0].sub).toBeTruthy()
  })

  test('⚠ the balance is fetched ONCE — opening the menu again fires no request', async ({ page }) => {
    // §UC-PI-004: "one request per session load, shared state". The per-open half
    // is the one this row owns, and it is the one a naive implementation gets
    // wrong (fetch on open = a request per gesture).
    const friend = await makeFriend('Once')
    await signIn(page, friend)
    await stubCycles(page, [cycleRow({ n: 13, status: 'open' })])
    let balanceCalls = 0
    await page.route('**/api/friends/*/balance', (route) => {
      balanceCalls += 1
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: -1, transactions: [] }) })
    })
    await open(page)
    await openMenu(page)
    await expect(drawer(page).locator('.badge')).toHaveCount(1)
    const afterFirst = balanceCalls
    expect(afterFirst, 'the session fetched the balance').toBeGreaterThan(0)

    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Escape')
      await expect(drawer(page)).toHaveCount(0)
      await openMenu(page)
      await expect(drawer(page).locator('.badge')).toHaveCount(1)
    }
    expect(balanceCalls, 'opening the menu must not refetch the balance').toBe(afterFirst)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 1b. ITEM 4 — „Zdieľať s kolegami" (PI-T3)
//
// ⚠⚠ THIS SECTION IS WHERE `portal-share-row.spec.js` WENT. That file (14 tests)
// was deleted with the cycle card it tested (18 §UC-PI-005 / §UC-PI-019 item 6).
// Most of it died with the card — the 378px row geometry, the 2px rule, the
// card-scoped locators. What did NOT die is here, re-pinned on the surfaces that
// replaced it (the other half, the dialog ENTRY contract, is in
// `portal-landing.spec.js`):
//
//   · the four COPY states of the colleague count (declined phrase, kilos,
//     cancelled sub-orders excluded, the zero/failed fallback) → the sub-line;
//   · „the count is CONTEXT ONLY — it gates nothing" → a failed count still leaves
//     the row present and the dialog working;
//   · „the fan-out is BOUNDED" (a 3-at-a-time cap over every open cycle) → the
//     STRONGER form §UC-PI-004 specifies: exactly ONE request, for the current open
//     round, whatever the payload's size;
//   · the SESSION SCOPING half of the `loadSeq` rule (a count must not cross a
//     logout, settled or in flight).
//
// ⚠ ONE PROPERTY HAS NO NEW HOME, AND IT IS A FINDING RATHER THAN AN OVERSIGHT:
// „a response deferred past a SECOND `loadCycles` (same session) is dropped". Its
// only trigger was `saveSubscriptions()`, the last caller of `loadCycles()`, retired
// with the gear (§UC-PI-016). `cycles` is loaded once per session now, so there is
// no second batch to supersede and NO test can red on that branch. The counter and
// its guard are kept in `FriendPortalSession.vue`, with a comment saying exactly
// this, so the next in-session reloader inherits the protection instead of
// re-discovering the race.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T3 · 18 §UC-PI-004 item 4 — the colleague count', () => {
  /**
   * The `{ link, guest_orders, totals }` payload of `GET /guest-links/cycle/:id`,
   * trimmed to what the sub-line reads (the shape `helpers/guest-orders.js` serves).
   *
   * One 250 g bag per colleague ⇒ grams = count × 250. `cancelled: true` appends a
   * sub-order carrying a 1 kg bag that must NOT reach the screen — the client applies
   * the same status predicate every guest aggregate in the backend does, and 1 kg is
   * large enough that a leak is unmissable rather than a rounding argument.
   */
  const linkPayload = (count, { cancelled = false, variant = '250g' } = {}) => ({
    link: { id: 1, token: 'E2EPI3TOKEN0', host_friend_id: 0, cycle_id: 0, active: 1 },
    guest_orders: [
      ...Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        status: 'submitted',
        total: 4.2,
        items: [{ id: i + 1, product_id: 1, variant, quantity: 1 }],
      })),
      ...(cancelled ? [{
        id: 900, status: 'cancelled', total: 0,
        items: [{ id: 900, product_id: 1, variant: '1kg', quantity: 1 }],
      }] : []),
    ],
    totals: { count, total: count * 4.2 },
  })

  /** A cycle id absent from `counts` is answered 500 — the „failed fetch" half. */
  async function stubCounts(page, counts) {
    await page.route('**/api/guest-links/cycle/*', (route) => {
      const id = Number(route.request().url().split('/').pop())
      if (!(id in counts)) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      const spec = typeof counts[id] === 'number' ? { count: counts[id] } : counts[id]
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(linkPayload(spec.count, spec)),
      })
    })
  }

  /** Item 4's sub-line, read off the OPEN drawer. */
  async function shareSub(page) {
    const seen = await rows(page)
    const row = seen.find((r) => r.label === 'Zdieľať s kolegami')
    return row ? row.sub : null
  }

  // ⚠ EVERY TEST IN THIS BLOCK RUNS ON `/zostatok`, NOT ON `/`, AND THAT IS THE
  // POINT. `GuestSubOrders.vue` (the Kolegovia panel inside `FriendOrder`) makes its
  // OWN `GET /guest-links/cycle/:id` and is mounted on the landing — so counting
  // requests there measures two components at once. On any other view the embedded
  // `FriendOrder` is not mounted, the session's fetch is the only one, and „exactly
  // one" is a claim about the code under test. The drawer is identical on all four
  // views: item 4's condition is the landing STATE, never the view.
  const AT = '/zostatok'

  test('the sub-line declines the count, prints the kilos, and drops trailing zeros', async ({ page }) => {
    const friend = await makeFriend('Count')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 30, status: 'open' })])
    await stubCounts(page, { 70030: 4 })
    await open(page, AT)

    await openMenu(page)
    // 4 × 250 g = 1000 g. `lib/kg.js kgLabel()` returns the WHOLE „1 kg" string —
    // „1.00 kg" would mean someone reformatted at the call site (FUP-T24).
    await expect.poll(() => shareSub(page)).toBe('4 kolegovia · 1 kg cez váš odkaz')
  })

  test('the count is DECLINED, and a cancelled sub-order reaches neither figure', async ({ page }) => {
    const friend = await makeFriend('Decl')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 31, status: 'open' })])
    // `totals.count` is 1 — the SERVER's cancelled-excluding figure — while the
    // payload also carries a cancelled 1 kg bag. If the client summed blindly the
    // kilos would read „1.25 kg", which is why the bag is 1 kg and not 250 g.
    await stubCounts(page, { 70031: { count: 1, cancelled: true } })
    await open(page, AT)

    await openMenu(page)
    await expect.poll(() => shareSub(page)).toBe('1 kolega · 0.25 kg cez váš odkaz')
  })

  test('a count with no item rows drops the „· " separator instead of printing „0 kg"', async ({ page }) => {
    const friend = await makeFriend('NoKg')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 32, status: 'open' })])
    // `unit` is priceable but ZERO-GRAM (CLAUDE.md, `helpers/pricing.js`), so this is
    // a real payload rather than a contrived one.
    await stubCounts(page, { 70032: { count: 3, variant: 'unit' } })
    await open(page, AT)

    await openMenu(page)
    await expect.poll(() => shareSub(page)).toBe('3 kolegovia cez váš odkaz')
    expect(await shareSub(page), '„· 0 kg" reads as a failure, not as „no weight yet"')
      .not.toContain('0 kg')
  })

  test('zero colleagues AND a failed fetch are the same sub-line — never an error', async ({ page }) => {
    const friend = await makeFriend('Zero')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 33, status: 'open' })])
    await stubCounts(page, { 70033: 0 })
    await open(page, AT)
    await openMenu(page)
    await expect.poll(() => shareSub(page), { message: 'count 0' }).toBe('Pošlite odkaz kolegom')
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    // The 500 branch — indistinguishable by design (§UC-PI-004: „failure ⇒ the
    // „Pošlite odkaz kolegom" sub, never an error").
    await stubCounts(page, {})
    await open(page, AT)
    await openMenu(page)
    await expect.poll(() => shareSub(page), { message: 'failed fetch' }).toBe('Pošlite odkaz kolegom')
    // …and the failure produced no banner anywhere on the page.
    await expect(page.locator('.banner.danger')).toHaveCount(0)
  })

  test('⚠ the fetch is ONE request for the CURRENT round — never one per open round', async ({ page }) => {
    // THE RETARGET OF „the colleague-count fan-out is BOUNDED" (RD-FL-8a item 3).
    // Module 03 issued one GET per OPEN cycle behind a 3-at-a-time cap, because this
    // database reaches 135 open rounds and an unbounded `Promise.all` queued behind
    // the browser's 6-connection limit together with the portal's own requests.
    // §UC-PI-004 replaces the cap with a stronger bound — ONE — and this asserts it
    // as the SET of cycle ids requested, which is what makes it immune to the old
    // shape: a re-introduced fan-out asks for 40 ids, and a cap of 3 still asks 40.
    const friend = await makeFriend('One')
    await signIn(page, friend)
    await stubBalance(page, 0)

    const MANY = 40
    // ⚠ `created_at` must be STRICTLY ascending with the index, so the LAST row is
    // unambiguously the newest ⇒ the landing's round. (A first attempt wrapped the
    // day at `i % 28` and row 27 came out newest — the test then „failed" on a
    // perfectly correct single request. `resolveLanding` sorts `created_at DESC,
    // id DESC`, not by id.) Two months carry 40 days.
    const bulk = Array.from({ length: MANY }, (_, i) => cycleRow({
      n: 400 + i,
      status: 'open',
      created_at: `2026-${String(9 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')} 10:00:00`,
    }))
    const current = bulk[MANY - 1]
    await stubCycles(page, bulk)

    const asked = []
    const order = []
    await page.route('**/api/guest-links/cycle/*', (route) => {
      asked.push(Number(route.request().url().split('/').pop()))
      order.push('count')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linkPayload(2)) })
    })
    await page.route('**/api/vouchers/pending*', (route) => {
      order.push('vouchers')
      return route.fulfill({ json: [] })
    })

    await open(page, AT)
    await openMenu(page)
    // Wait for the sub-line, so the count really landed before anything is counted —
    // otherwise „one request" would also be satisfied by „none yet".
    await expect.poll(() => shareSub(page)).toBe('2 kolegovia · 0.5 kg cez váš odkaz')
    await page.waitForTimeout(500)

    expect(asked, `${MANY} open rounds must still produce ONE count request`).toEqual([current.id])

    // The ORDERING half, also inherited: decoration is never issued ahead of the
    // fetch that decides what the screen shows.
    expect(order.indexOf('vouchers'), 'the voucher check precedes the count')
      .toBeLessThan(order.indexOf('count'))
  })

  test('no open round ⇒ no count request at all, and no row to put it on', async ({ page }) => {
    const friend = await makeFriend('Closed')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 34, status: 'locked' }), cycleRow({ n: 35, status: 'completed' })])
    const asked = []
    await page.route('**/api/guest-links/cycle/*', (route) => {
      asked.push(route.request().url())
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linkPayload(3)) })
    })
    await open(page, AT)
    await openMenu(page)
    // Non-vacuity: the drawer really rendered — it just has no item 4.
    expect((await rows(page)).length).toBe(6)
    await page.waitForTimeout(500)
    expect(asked, 'a closed/locked landing asks nobody about colleagues').toEqual([])
  })

  test('⚠ a count does NOT survive a logout into the next session', async ({ page }) => {
    // A stale count is not a cosmetic leak: it is the PREVIOUS host's colleague data,
    // on a device the two of them share. The parent's `v-if` + `:key` is what makes
    // this structural — the session component, and every ref in it, is destroyed.
    const friend = await makeFriend('Leak')
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'modern' } }))
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 36, status: 'open' })])

    let serve = true
    await page.route('**/api/guest-links/cycle/*', (route) => (serve
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linkPayload(5)) })
      : route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })))

    await open(page, AT)
    await openMenu(page)
    // ⚠ „5 kolegov", not „5 kolegovia": Slovak takes the genitive plural from five up.
    // `lib/plural.js colleaguesLabel()` owns that rule; the fixture is deliberately at
    // 5 so a naive „{n} kolegovia" would red here.
    await expect.poll(() => shareSub(page)).toBe('5 kolegov · 1.25 kg cez váš odkaz')
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    // The NEXT session's own fetch fails, so a number on screen can only be the
    // previous session's.
    serve = false
    await logout(page)
    await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
    await page.getByLabel(/^heslo$/i).fill('ownPass12')
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
    await expectLanding(page)

    await openMenu(page)
    expect(await shareSub(page)).toBe('Pošlite odkaz kolegom')
  })

  test('⚠ a response deferred past a LOGOUT is dropped, not written', async ({ page }) => {
    // Demonstrated, not argued: the first request is HELD until after the session has
    // ended and a new one has begun, so the response really does land on a screen it
    // was not fetched for.
    const friend = await makeFriend('Defer')
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'modern' } }))
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 37, status: 'open' })])

    let calls = 0
    let held = false
    let resolveLanded
    const landed = new Promise((resolve) => { resolveLanded = resolve })
    await page.route('**/api/guest-links/cycle/*', async (route) => {
      calls += 1
      if (!held) {
        held = true
        await new Promise((r) => setTimeout(r, 2500))
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linkPayload(7)) })
        resolveLanded()
        return
      }
      // Every LATER fetch yields nothing, so a „7" on screen can only be the
      // deferred one.
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    })

    await open(page, AT)
    await openMenu(page)
    expect(await shareSub(page), 'still in flight ⇒ the fallback, not a figure').toBe('Pošlite odkaz kolegom')
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    await logout(page)
    await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
    await page.getByLabel(/^heslo$/i).fill('ownPass12')
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
    await expectLanding(page)

    await landed
    await page.waitForTimeout(500)
    await openMenu(page)
    expect(await shareSub(page), "a stale response must not write another session's count")
      .toBe('Pošlite odkaz kolegom')
    expect(calls, 'the second session did fetch — it just got nothing').toBeGreaterThan(1)
  })

  test('item 1 appends „ · v košíku {suma}" once the LANDING cart is non-empty', async ({ page }) => {
    // §UC-PI-004 item 1's second clause, which needed a landing cart and therefore
    // waited for this row. The cart has ONE home (`FriendOrder.vue`); the drawer
    // reads it through `defineExpose`, so this also pins that the bridge is live.
    const friend = await makeFriend('Cart')
    const cycle = await makeRealCycle('Cart')
    await addProduct(cycle.id, { name: `PI3 Cart Bean ${uniq}`, purpose: 'Espresso', price_250g: 7.5 })

    await signIn(page, friend)
    await stubBalance(page, 0)
    await open(page, '/')

    // Empty basket ⇒ no clause at all.
    await openMenu(page)
    let shop = (await rows(page)).find((r) => r.label === 'Aktuálna ponuka')
    expect(shop.sub, 'an empty basket adds nothing').not.toContain('v košíku')
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    await page.getByTestId('product-card').first()
      .getByRole('button', { name: 'viac' }).first().click()
    await expect(page.locator('.app .cartbar .sum')).toContainText('7.50 EUR')

    await openMenu(page)
    shop = (await rows(page)).find((r) => r.label === 'Aktuálna ponuka')
    expect(shop.sub).toContain('· v košíku 7.50 EUR')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Navigation, `.on`, and "close first, then act"
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T2 · 18 §UC-PI-004 — choosing a row', () => {
  test('each navigating row goes to its route, and the drawer is gone before it does', async ({ page }) => {
    const friend = await makeFriend('Nav')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 14, status: 'open' })])
    await open(page)

    for (const [label, path] of [
      ['Moje objednávky', '/moje-objednavky'],
      ['Zostatok a platby', '/zostatok'],
      ['Ako to funguje', '/ako-to-funguje'],
    ]) {
      // ⚠ §UC-PI-004 is „close FIRST, then act", so the drawer is gone BEFORE the
      // router has navigated — `menuGo` returns on the first half. The URL is
      // therefore asserted with a retrying matcher, never with a one-shot read of
      // `page.url()`, which raced (measured: „/" instead of „/moje-objednavky").
      await menuGo(page, label)
      await expect(page, label).toHaveURL(new RegExp(`${path}$`))
      await expect(page.getByRole('dialog'), `${label} left the drawer open`).toHaveCount(0)
    }

    // …and back to the offer. „Ako to funguje" has no hamburger, so this one has
    // to travel via the back chevron — which is the swap §UC-PI-003 specifies.
    await page.locator('.appbar [aria-label="Späť"]').click()
    await expect(page).toHaveURL(/\/$/)
    await menuGo(page, 'Moje objednávky')
    await expect(page).toHaveURL(/\/moje-objednavky$/)
    await menuGo(page, 'Aktuálna ponuka')
    await expect(page).toHaveURL(/\/$/)
  })

  test('the row whose view is current carries `.on`, and only it', async ({ page }) => {
    const friend = await makeFriend('On')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 15, status: 'open' })])

    for (const [path, label] of [
      ['/', 'Aktuálna ponuka'],
      ['/moje-objednavky', 'Moje objednávky'],
      ['/zostatok', 'Zostatok a platby'],
    ]) {
      await open(page, path)
      await openMenu(page)
      const seen = await rows(page)
      expect(seen.filter((r) => r.on).map((r) => r.label), path).toEqual([label])
      await page.keyboard.press('Escape')
      await expect(drawer(page)).toHaveCount(0)
    }

    // The explainer view has no drawer to open (no hamburger), which is itself the
    // §UC-PI-003 rule — so „Ako to funguje" can never be its own `.on` row, and
    // that is by design rather than an omission.
    await open(page, '/ako-to-funguje')
    await expect(page.locator('.appbar [aria-label="Menu"]')).toHaveCount(0)
  })

  test('„Pozvať priateľa" and „Profil" open their modals, and navigate nowhere', async ({ page }) => {
    const friend = await makeFriend('Modals')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 16, status: 'open' })])
    await open(page, '/moje-objednavky')

    await menuGo(page, 'Pozvať priateľa')
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText('Pozvi priateľa')
    expect(new URL(page.url()).pathname, 'a modal row must not navigate').toBe('/moje-objednavky')
    await page.getByRole('dialog').getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await menuGo(page, 'Profil')
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText('Upraviť profil')
    expect(new URL(page.url()).pathname).toBe('/moje-objednavky')
  })

  test('the footer logs out — and the footer is the ONLY logout control now', async ({ page }) => {
    const friend = await makeFriend('Out')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 17, status: 'open' })])
    await open(page)

    // Nothing in the appbar logs out any more (§UC-PI-003 retired the glyph).
    await expect(page.locator('.appbar [aria-label="Odhlásiť sa"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Odhlásiť sa' })).toHaveCount(0)

    const menu = await openMenu(page)
    await expect(menu.getByText('podpultovka.biz')).toBeVisible()
    await expect(menu.getByRole('button', { name: 'Odhlásiť sa' })).toHaveCount(1)

    await menu.getByRole('button', { name: 'Odhlásiť sa' }).click()
    await expectNoLanding(page)
    await expect(page.getByText('Prihlásenie')).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('gorifi_friend_auth'))).toBeNull()
    // The drawer went with the session — it is not left hanging over the login card.
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. The shell: the modal layer, the three close paths, the focus trap
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T2 · 18 §UC-PI-004 — `NeoDrawer` on the modal layer', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 })
  })

  test('⚠ it is TELEPORTED out of `.app` and really fixed — the `.app > *` trap', async ({ page }) => {
    // CLAUDE.md §Frontend: `.app > * { position:relative; z-index:1 }` at (0,1,0)
    // loads after Tailwind, so a hand-rolled fixed drawer mounted as a direct child
    // of `.app` silently computes `relative` / `z-index:1` and renders in the page
    // flow. This is the guard against somebody rebuilding it that way.
    const friend = await makeFriend('Layer')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 18, status: 'open' })])
    await open(page)
    await openMenu(page)

    const shell = await page.evaluate(() => {
      const layer = document.querySelector('.modal-layer')
      const aside = document.querySelector('.p2-drawer')
      return {
        insideApp: !!aside.closest('.app'),
        layerPosition: layer ? getComputedStyle(layer).position : null,
        layerZ: layer ? getComputedStyle(layer).zIndex : null,
        tag: aside.tagName,
        role: aside.getAttribute('role'),
        ariaModal: aside.getAttribute('aria-modal'),
        ariaLabel: aside.getAttribute('aria-label'),
        // The scrim must be the thing that catches the pointer — the layer itself
        // is `pointer-events:none`.
        scrimEvents: getComputedStyle(document.querySelector('.p2-drawer-scrim')).pointerEvents,
        drawerWidth: aside.getBoundingClientRect().width,
        drawerHeight: aside.getBoundingClientRect().height,
      }
    })
    expect(shell.insideApp, '`.app` descendant ⇒ `.app > *` can neutralise its positioning').toBe(false)
    expect(shell.layerPosition).toBe('fixed')
    expect(shell.layerZ).toBe('200')
    expect(shell.tag).toBe('ASIDE')
    expect(shell.role).toBe('dialog')
    expect(shell.ariaModal).toBe('true')
    expect(shell.ariaLabel).toBe('Menu')
    expect(shell.scrimEvents).toBe('auto')
    // `width:86%` capped at 330, full height — the ported canon (A13).
    expect(shell.drawerWidth).toBeLessThanOrEqual(330)
    expect(Math.round(shell.drawerHeight)).toBe(800)

    await expect(page.locator('.app .p2-drawer')).toHaveCount(0)
    await expect(page.locator('.modal-layer .p2-drawer')).toHaveCount(1)
  })

  test('⚠ closed, it is not in the DOM at all — `getByRole(\'dialog\')` stays at ONE meaning', async ({ page }) => {
    // 28 shipped spec files resolve `getByRole('dialog')`. A drawer rendered but
    // hidden would make every one of them a strict-mode violation; `v-if` is what
    // keeps that from happening, and this is the assertion that would red if it
    // were ever swapped for `v-show`.
    const friend = await makeFriend('Vif')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 19, status: 'open' })])
    await open(page)

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.p2-drawer')).toHaveCount(0)
    await openMenu(page)
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.p2-drawer')).toHaveCount(0)

    // …and the OTHER dialogs on this screen still resolve to exactly one while the
    // drawer is closed — the property the 28 files depend on.
    await menuGo(page, 'Profil')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText('Upraviť profil')
  })

  test('all three close paths: ×, Escape, and a scrim click', async ({ page }) => {
    const friend = await makeFriend('Close')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 20, status: 'open' })])
    await open(page)

    // ×
    let menu = await openMenu(page)
    // ⚠ A13 DEVIATION D1, pinned. The prototype writes `.app .p2-icobtn`, which in
    // production does NOT reach this button: the drawer is teleported OUT of `.app`
    // onto the modal layer, where the prototype's own layer lives INSIDE it. The
    // ported rule therefore carries a `.modal-layer` scope too, and without it this
    // × collapses to a bare 18px glyph — under UC-DS-005's 44px hit-target minimum.
    const xBox = await menu.locator('[aria-label="Zatvoriť menu"]').boundingBox()
    expect(Math.round(xBox.width), 'the × keeps its 44px hit target').toBe(44)
    expect(Math.round(xBox.height)).toBe(44)
    await menu.locator('[aria-label="Zatvoriť menu"]').click()
    await expect(drawer(page)).toHaveCount(0)

    // Escape
    menu = await openMenu(page)
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    // A scrim click, to the RIGHT of the 330px drawer.
    await openMenu(page)
    const box = await page.locator('.p2-drawer').boundingBox()
    await page.mouse.click(box.x + box.width + 40, 400)
    await expect(drawer(page)).toHaveCount(0)
  })

  test('⚠ a drag that STARTS inside the drawer and ends on the scrim does NOT close it', async ({ page }) => {
    // The RD-FL-6 rule, inherited from `use-modal-layer.js` rather than
    // re-implemented: a `click` fires on the nearest common ancestor of mousedown
    // and mouseup, so a text-selection drag out of the panel delivers a click whose
    // target IS the scrim. `@click.self` alone would close on it.
    const friend = await makeFriend('Drag')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 21, status: 'open' })])
    await open(page)
    await openMenu(page)

    const box = await page.locator('.p2-drawer').boundingBox()
    await page.mouse.move(box.x + 30, box.y + 40)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width + 60, box.y + 60, { steps: 8 })
    await page.mouse.up()
    await expect(drawer(page), 'a selection drag must not dismiss the menu').toBeVisible()

    // Non-vacuity: a real scrim click at the very same point still closes it, so
    // the assertion above is about the GESTURE and not about an unreachable point.
    await page.mouse.click(box.x + box.width + 60, box.y + 60)
    await expect(drawer(page)).toHaveCount(0)
  })

  test('⚠ Tab and Shift+Tab cannot escape the drawer', async ({ page }) => {
    const friend = await makeFriend('Trap')
    await signIn(page, friend)
    await stubBalance(page, -3)
    await stubCycles(page, [cycleRow({ n: 22, status: 'open' })])
    await open(page)
    await openMenu(page)

    const state = () => page.evaluate(() => {
      const aside = document.querySelector('.p2-drawer')
      const active = document.activeElement
      return { inside: !!aside && aside.contains(active), tag: active ? active.tagName : 'NONE' }
    })

    const forward = []
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      const s = await state()
      forward.push(s.tag)
      expect(s.inside, `Tab #${i + 1} escaped the drawer → ${JSON.stringify(forward)}`).toBe(true)
    }
    expect(new Set(forward).size, `Tab did not move focus: ${JSON.stringify(forward)}`).toBeGreaterThan(1)

    const backward = []
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab')
      const s = await state()
      backward.push(s.tag)
      expect(s.inside, `Shift+Tab #${i + 1} escaped the drawer → ${JSON.stringify(backward)}`).toBe(true)
    }
    expect(new Set(backward).size).toBeGreaterThan(1)
  })

  test('the page behind is scroll-locked while the drawer is open, and released after', async ({ page }) => {
    const friend = await makeFriend('Lock')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 23, status: 'open' })])
    await open(page)

    // ⚠ THE SAVED VALUE MUST BE NON-EMPTY, OR THIS TEST CANNOT FAIL FOR ITS STATED
    // REASON. `document.body.style.overflow` is `''` on a stock page, so a plain
    // `toBe(before)` is satisfied by „restore the SAVED value" and by „hardcode `''`"
    // alike — the composable's M5 behaviour (restore what was there) would have been
    // free to break. Seeding a real value makes the two outcomes different strings.
    // Found in the PI-T2 review: the extraction moved this behaviour with NO test
    // watching it.
    // ⚠ NOT `addInitScript` — that runs at document-start, when `document.body` is
    // still null, so the assignment no-ops and `before` is `''` again. (Measured: the
    // non-vacuity line below caught exactly that on the first attempt.) Setting it
    // after the page is up is also the honest fixture: the composable saves whatever
    // it finds AT LOCK TIME, which is this.
    await page.evaluate(() => { document.body.style.overflow = 'scroll' })

    const before = await page.evaluate(() => document.body.style.overflow)
    expect(before, 'the fixture really seeded a non-empty overflow').toBe('scroll')

    await openMenu(page)
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')

    // M6 — focus moves INTO the drawer on mount.
    expect(await page.evaluate(() => !!document.activeElement?.closest('.p2-drawer')),
      'focus lands inside the drawer').toBe(true)

    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)
    expect(await page.evaluate(() => document.body.style.overflow),
      'the SAVED overflow is restored, not a hardcoded empty string').toBe(before)

    // M7 — focus returns to the opener.
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      'focus returns to the hamburger that opened it').toBe('Menu')
  })

  test('every row and the × are keyboard-operable (Enter AND Space)', async ({ page }) => {
    const friend = await makeFriend('Keys')
    await signIn(page, friend)
    await stubBalance(page, 0)
    await stubCycles(page, [cycleRow({ n: 24, status: 'open' })])
    await open(page)

    // Enter on a row.
    let menu = await openMenu(page)
    await menu.getByRole('button', { name: 'Moje objednávky' }).focus()
    await page.keyboard.press('Enter')
    await expect(drawer(page)).toHaveCount(0)
    await expect(page).toHaveURL(/\/moje-objednavky$/)

    // Space on a row — and it is preventDefault'ed, so the page does not scroll.
    menu = await openMenu(page)
    await menu.getByRole('button', { name: 'Zostatok a platby' }).focus()
    const scrollBefore = await page.evaluate(() => window.scrollY)
    await page.keyboard.press(' ')
    await expect(drawer(page)).toHaveCount(0)
    await expect(page).toHaveURL(/\/zostatok$/)
    expect(await page.evaluate(() => window.scrollY), 'Space must not also scroll').toBe(scrollBefore)

    // Enter on the ×.
    menu = await openMenu(page)
    await menu.locator('[aria-label="Zatvoriť menu"]').focus()
    await page.keyboard.press('Enter')
    await expect(drawer(page)).toHaveCount(0)
    expect(new URL(page.url()).pathname, 'closing the menu navigates nowhere').toBe('/zostatok')
  })

  test('⚠ the drawer is SESSION state: it does not survive a logout into the next session', async ({ page }) => {
    // The session-boundary rule (18 §UC-PI-001) applied to `menuOpen` and to the
    // balance badge: both live in `FriendPortalSession.vue`, which the parent's
    // `v-if` destroys. Friend A's menu — and A's money — must not greet friend B.
    const a = await makeFriend('Alfa')
    const b = await makeFriend('Beta')
    await signIn(page, a)
    await stubCycles(page, [cycleRow({ n: 25, status: 'open' })])
    await page.route('**/api/friends/*/balance', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ balance: -99.99, transactions: [] }),
    }))
    await open(page)
    await openMenu(page)
    await expect(drawer(page).locator('.badge')).toHaveText('-99.99 EUR')

    // ⚠ Logged out FROM the open drawer, on purpose: `logout(page)` would first try
    // to click the appbar's hamburger, which is behind the scrim. This is also the
    // real gesture — the footer button is inside the drawer.
    await drawer(page).getByRole('button', { name: 'Odhlásiť sa' }).click()
    await expectNoLanding(page)
    await expect(page.getByRole('dialog'), 'the drawer went with the session').toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('-99.99 EUR')
    // ⚠ NOT „the body must not contain A's name" here: this is the LEGACY login
    // card, whose „Vyberte svoje meno" dropdown lists every friend in the database
    // by name — so that assertion is unsatisfiable on this screen and would have
    // been a false alarm, not a leak. The identity claim is made below, on B's
    // session, where it is both meaningful and discriminating.

    // B signs in on the SAME document — no reload, so a ref that survived would show.
    await page.unroute('**/api/friends/*/balance')
    await page.route('**/api/friends/*/balance', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ balance: 7.5, transactions: [] }),
    }))
    await signIn(page, b)
    await page.reload()
    await expectLanding(page)
    await openMenu(page)
    await expect(drawer(page).getByTestId('drawer-friend-name')).toHaveText(b.name)
    await expect(drawer(page).locator('.badge')).toHaveText('7.50 EUR')
    expect(a.name).not.toBe(b.name)
    // Nothing of A's is left in B's session chrome.
    await expect(drawer(page)).not.toContainText(a.name)
    await expect(drawer(page)).not.toContainText('-99.99 EUR')
  })
})
