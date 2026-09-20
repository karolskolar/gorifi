import { test, expect, request as playwrightRequest } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { expectLanding, expectNoLanding, LANDING } from '../helpers/portal.js'

// PI-T1 — module 18 (portal information architecture), 18 §UC-PI-001 /
// §UC-PI-002 / §UC-PI-019 items 1, 2, 15. The SHELL: four routes on one session,
// the landing-state resolver, the short-date library, the friend cycles payload
// extension, and the „portal is ready" marker ~30 spec files now gate on.
//
// What carries this file, in the order of how badly each one bites:
//
//  1. ⚠ **THE RETARGETED GATE HAS TO BE ABLE TO FAIL.** 60 assertions in 28 files
//     moved from a heading to `expectLanding(page)` in this row. A marker that is
//     present on the LOGIN screen too — or one Playwright resolves to a hidden
//     node — would turn all 60 into assertions that cannot fail, silently, and
//     the retarget would have removed a gate rather than moved it. So the first
//     describe drives the discriminating pair on ONE page object: absent before
//     sign-in, present after, absent again after logout.
//
//  2. ⚠ **`nextText` AND THE open→locked PRECEDENCE ARE NOT NEW.** Module 17
//     shipped `nextOpeningText()` and `currentCycleFor()` yesterday and §UC-PI-002
//     is written as if neither existed. `resolveLanding` therefore DELEGATES, and
//     that is asserted two ways that a re-implementation could not both satisfy:
//     the sentence is byte-equal to 17's (a copy built on §UC-PI-002's
//     `fmtDayMonth` would read „približne 3. 10." instead of „približne 3.
//     októbra"), and the two-open warning still carries 17's `[cycle-stages]` tag.
//
//  3. ⚠ **THE DOM STUBS COME IN DISCRIMINATING PAIRS.** `data-landing-state` is
//     read off the real app with `page.route` feeding it crafted cycle arrays. A
//     stub that silently failed to apply would leave the SEEDED state on screen —
//     so each pair asserts two states that cannot both be the seeded one.
//
//  4. The payload extension is asserted on a REAL order driven through the real
//     routes (submit → packed → handed-over → paid), because `orderPaid` /
//     `orderHandedOver` defaulting to `false` is satisfied by a route that reads
//     neither column.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND_SRC = resolve(HERE, '../../frontend/src')
const HAS_SRC = existsSync(FRONTEND_SRC)
const NEEDS_SRC = 'needs the frontend source beside e2e/ (skipped against a deployment)'
const LIB_PORTAL_STATE = join(FRONTEND_SRC, 'lib/portal-state.js')
const LIB_DATES = join(FRONTEND_SRC, 'lib/dates.js')
const LIB_CYCLE_STAGES = join(FRONTEND_SRC, 'lib/cycle-stages.js')

let ctx = null
let adminToken = ''

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `pi1_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `PI1 ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: '0900 000 000' } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()
  // An admin reset raises `must_change_password`; clear it so the portal is not
  // gated by the forced-change modal (03 UC-FL-012 is modern-login.spec.js's job).
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token
  return { id: row.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

/** Sign the browser in the "remember me" way — nothing else is stubbed. */
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

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => { await ctx?.dispose() })

// ═════════════════════════════════════════════════════════════════════════════
// 1. §UC-PI-019 item 1 — the marker, and whether the retargeted gate GATES
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T1 · 18 §UC-PI-019 item 1 — the „portal is ready" marker', () => {
  test('⚠ the gate DISCRIMINATES: absent anonymous, present signed in, absent after logout', async ({ page }) => {
    // ⚠ THE WHOLE POINT OF THIS TEST. 60 call sites in 28 files were retargeted
    // from a heading onto `expectLanding(page)` in this row. If the marker were
    // also present on the login screen, every one of those 60 would still pass
    // while proving nothing — the classic „assertion whose expected value is also
    // produced by the environment it runs in". The three states are driven on ONE
    // page object so the claim is about the marker, not about three fixtures.
    const friend = await makeFriend('Gate')

    await page.goto('/')
    await expect(page.getByText('Prihlásenie')).toBeVisible()
    await expectNoLanding(page)

    await signIn(page, friend)
    await page.reload()
    await expectLanding(page)

    await page.locator('.appbar span[aria-label="Odhlásiť sa"]').click()
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
    await expectNoLanding(page)
  })

  test('the marker resolves to exactly ONE element, and it is a direct child of `.app`', async ({ page }) => {
    // Strict-mode insurance for 28 files at once: a second `portal-landing`
    // anywhere would make every retargeted `expectLanding` throw instead of
    // assert. The `.app >` half is the shipped page-column placement (03
    // UC-FL-006) — `.app > * { position:relative; z-index:1 }` is what lifts the
    // column over the halftone texture (CLAUDE.md `.app > *` cascade).
    const friend = await makeFriend('Single')
    await signIn(page, friend)
    await page.goto('/')
    await expectLanding(page)
    await expect(page.getByTestId(LANDING)).toHaveCount(1)
    await expect(page.locator(`.app > [data-testid="${LANDING}"]`)).toHaveCount(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. §UC-PI-001 — four routes, one session component, no auth guard
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T1 · 18 §UC-PI-001 — the four routes and the session boundary', () => {
  const VIEWS = [
    ['/', 'shop'],
    ['/moje-objednavky', 'history'],
    ['/zostatok', 'balance'],
    ['/ako-to-funguje', 'explainer'],
  ]

  test('each of the four paths renders the session with its own `meta.view`', async ({ page }) => {
    const friend = await makeFriend('Views')
    await signIn(page, friend)
    for (const [path, view] of VIEWS) {
      await page.goto(path)
      await expectLanding(page)
      // ⚠ Asserted per path, and the four values are DISTINCT — a component that
      // ignored `meta.view` and hardcoded one string would satisfy exactly one row.
      await expect(page.getByTestId(LANDING)).toHaveAttribute('data-view', view)
      expect(new URL(page.url()).pathname, 'the route is not rewritten').toBe(path)
    }
    expect(new Set(VIEWS.map(([, v]) => v)).size, 'the four views are four values').toBe(4)
  })

  test('anonymous ⇒ the LOGIN state on the same URL, never a redirect to `/`', async ({ page }) => {
    // §UC-PI-001: logging in must land on the view that was asked for, so the
    // three new paths carry no auth guard and must not bounce to `/`.
    for (const [path] of VIEWS) {
      await page.goto(path)
      await expect(page.getByText('Prihlásenie')).toBeVisible()
      await expectNoLanding(page)
      expect(new URL(page.url()).pathname, `${path} keeps its URL while anonymous`).toBe(path)
    }
  })

  test('logout from `/moje-objednavky` ⇒ the login state on the SAME url', async ({ page }) => {
    const friend = await makeFriend('Logout')
    await signIn(page, friend)
    await page.goto('/moje-objednavky')
    await expectLanding(page)

    await page.locator('.appbar span[aria-label="Odhlásiť sa"]').click()
    await expectNoLanding(page)
    await expect(page.getByText('Prihlásenie')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/moje-objednavky')
    expect(await page.evaluate(() => localStorage.getItem('gorifi_friend_auth'))).toBeNull()
  })

  test('the session is ONE instance across the four views — the drawer-era boundary holds', async ({ page }) => {
    // The four views share `FriendPortalSession.vue`, so a friend switch must
    // still destroy everything. Friend A walks all four views, logs out, friend B
    // signs in: B must see the portal and NOTHING of A's identity (the six-leak
    // class this component exists to prevent — `portal-session-boundary.spec.js`).
    const a = await makeFriend('Alfa')
    const b = await makeFriend('Beta')

    await signIn(page, a)
    await page.goto('/')
    await expectLanding(page)
    for (const [path] of VIEWS) {
      await page.goto(path)
      await expectLanding(page)
    }
    await expect(page.locator('.appbar .titles .s')).toHaveText(a.name)

    await page.locator('.appbar span[aria-label="Odhlásiť sa"]').click()
    await expectNoLanding(page)

    await signIn(page, b)
    await page.reload()
    await expectLanding(page)
    await expect(page.locator('.appbar .titles .s')).toHaveText(b.name)
    // Non-vacuity: the two names are different, so „shows B" is a real claim.
    expect(a.name).not.toBe(b.name)
    await expect(page.locator('body')).not.toContainText(a.name)
  })

  test('⚠ no module-18 shell state is persisted, and none of it lives in the PARENT', async ({ page }) => {
    // The behavioural half of the session-boundary rule (the source half is in
    // §5 below): nothing this row adds may survive a logout in `localStorage`,
    // where friend A's session would greet friend B.
    const friend = await makeFriend('Keys')
    await signIn(page, friend)
    await page.goto('/zostatok')
    await expectLanding(page)
    await page.locator('.appbar span[aria-label="Odhlásiť sa"]').click()
    await expectNoLanding(page)

    const keys = await page.evaluate(() => Object.keys(localStorage))
    // Non-vacuity: `page.evaluate` really read this origin's storage.
    expect(Array.isArray(keys)).toBe(true)
    expect(
      keys.filter((k) => /view|landing|portal[-_]state|cycle/i.test(k)),
      `localStorage after logout: ${JSON.stringify(keys)}`,
    ).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. §UC-PI-002 — `resolveLanding()` against the REAL app (DOM), via `page.route`
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T1 · 18 §UC-PI-002 — the resolver, wired to the real payload', () => {
  /** A cycle row shaped like `GET /friends/cycles` publishes one. */
  const row = (over) => ({
    id: 90_000 + (over.n || 0), name: `PI1 Stub ${over.n || 0}`, status: 'planned',
    created_at: over.created_at || `2026-0${(over.n || 1) % 9 + 1}-01 10:00:00`,
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

  /**
   * Load `/` with a stubbed cycles payload and assert the landing state.
   *
   * ⚠ IT WAITS FOR THE RESPONSE FIRST, and that is not tidiness. `cycles` starts
   * EMPTY on a restore, so the pre-load reading of `data-landing-state` is
   * `closed` — an assertion that fired before the payload landed would pass for
   * every `closed` expectation for entirely the wrong reason. The wait closes
   * that window; the `open` / `locked` rows are what make the whole set
   * discriminating, because neither is the pre-load value.
   */
  async function expectLandingState(page, cycles, expected, why) {
    await stubCycles(page, cycles)
    const served = page.waitForResponse((r) => r.url().includes('/api/friends/cycles'), { timeout: TIMEOUT })
    await page.goto('/')
    await served
    await expectLanding(page)
    await expect(page.getByTestId(LANDING), why).toHaveAttribute('data-landing-state', expected)
  }

  test('⚠ open / locked / closed — and no single seeded answer satisfies the set', async ({ page }) => {
    // ⚠ THE SET IS THE POINT. If `page.route` silently failed to intercept, the
    // SEEDED cycles would answer every call and all four reads would return the
    // same string — so these four cannot all pass on a broken stub, whatever the
    // gate database happens to contain.
    const friend = await makeFriend('Resolve')
    await signIn(page, friend)

    await expectLandingState(page, [
      row({ n: 1, status: 'planned', opens_at: '2026-12-01' }),
      row({ n: 2, status: 'open', created_at: '2026-09-02 10:00:00' }),
      row({ n: 3, status: 'locked', created_at: '2026-09-03 10:00:00' }),
    ], 'open', 'an open round wins over a NEWER locked one')

    await expectLandingState(page, [
      row({ n: 1, status: 'planned' }),
      row({ n: 4, status: 'locked' }),
    ], 'locked', 'no open round ⇒ locked')

    await expectLandingState(page, [row({ n: 5, status: 'completed' })], 'closed',
      'only a finished round ⇒ closed')

    await expectLandingState(page, [], 'closed', 'no rounds at all ⇒ closed')
  })

  test('⚠ two open rounds ⇒ a `console.warn`, and it is module 17\'s', async ({ page }) => {
    // §UC-PI-002 (R1.2). The TAG is the load-bearing half: `[cycle-stages]` proves
    // the warning came from `currentCycleFor()` in module 17's lib and not from a
    // second precedence rule written beside it in `portal-state.js`.
    const friend = await makeFriend('TwoOpen')
    await signIn(page, friend)
    const warnings = []
    page.on('console', (msg) => { if (msg.type() === 'warning') warnings.push(msg.text()) })

    await expectLandingState(page, [
      row({ n: 6, status: 'open', created_at: '2026-09-06 10:00:00' }),
      row({ n: 7, status: 'open', created_at: '2026-09-07 10:00:00' }),
    ], 'open', 'the newest of two open rounds still wins')
    const mine = warnings.filter((w) => w.includes('are open at once'))
    expect(mine.length, `console warnings seen: ${JSON.stringify(warnings)}`).toBeGreaterThan(0)
    expect(mine[0]).toContain('[cycle-stages]')

    // Non-vacuity, the other direction: ONE open round warns about nothing. Without
    // this the test above would also pass against a lib that warned unconditionally.
    warnings.length = 0
    await expectLandingState(page, [row({ n: 8, status: 'open' })], 'open', 'one open round')
    expect(warnings.filter((w) => w.includes('are open at once'))).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. §UC-PI-002 — `lib/portal-state.js` and `lib/dates.js` as MODULES
//    (the `cycle-stages.spec.js` idiom: this project has no unit runner, and a
//    plain `node` import of a dependency-free lib IS the unit test)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T1 · 18 §UC-PI-002 — `resolveLanding()` and the delegation to module 17', () => {
  test.skip(!HAS_SRC, NEEDS_SRC)

  let ps = null
  let cs = null
  const TODAY = new Date('2026-09-20T12:00:00')

  test.beforeAll(async () => {
    ps = await import(pathToFileURL(LIB_PORTAL_STATE).href)
    cs = await import(pathToFileURL(LIB_CYCLE_STAGES).href)
  })

  const c = (over) => ({ id: 1, status: 'planned', created_at: '2026-09-01 10:00:00', ...over })

  test('the precedence table, all three rows, plus the `currentCycle` under `closed`', () => {
    const open = c({ id: 2, status: 'open', created_at: '2026-09-02 10:00:00' })
    const locked = c({ id: 3, status: 'locked', created_at: '2026-09-09 10:00:00' })
    const planned = c({ id: 1, status: 'planned' })
    const completed = c({ id: 4, status: 'completed', created_at: '2026-08-01 10:00:00' })

    const a = ps.resolveLanding([planned, open, locked], TODAY)
    expect(a.state).toBe('open')
    expect(a.currentCycle.id).toBe(open.id)

    const b = ps.resolveLanding([planned, locked, completed], TODAY)
    expect(b.state).toBe('locked')
    expect(b.currentCycle.id).toBe(locked.id)

    const d = ps.resolveLanding([completed], TODAY)
    expect(d.state).toBe('closed')
    // ⚠ `null`, never "the newest planned one": a planned round has no products a
    // friend may look at, and the closed grid reads `catalogCycle` instead.
    expect(d.currentCycle).toBeNull()

    const e = ps.resolveLanding([planned], TODAY)
    expect(e.state, 'a planned round alone is still a CLOSED landing').toBe('closed')
    expect(e.currentCycle).toBeNull()
  })

  test('`catalogCycle` is the newest of the UNION {locked, completed}, `null` when none', () => {
    const locked = c({ id: 3, status: 'locked', created_at: '2026-09-03 10:00:00' })
    const completedOlder = c({ id: 4, status: 'completed', created_at: '2026-09-01 10:00:00' })
    const completedNewer = c({ id: 5, status: 'completed', created_at: '2026-09-05 10:00:00' })

    // ⚠ A UNION, not "locked first": the newest COMPLETED beats an older locked.
    // A per-status precedence (the shape `currentCycleFor` uses) would answer 3.
    expect(ps.resolveLanding([locked, completedOlder, completedNewer], TODAY).catalogCycle.id).toBe(5)
    expect(ps.resolveLanding([locked, completedOlder], TODAY).catalogCycle.id).toBe(3)
    expect(ps.resolveLanding([c({ id: 9, status: 'planned' })], TODAY).catalogCycle).toBeNull()
    expect(ps.resolveLanding([], TODAY).catalogCycle).toBeNull()
  })

  test('`nextCycle` is the newest `planned` in EVERY state, and ties break on `id DESC`', () => {
    const open = c({ id: 2, status: 'open', created_at: '2026-09-09 10:00:00' })
    const p1 = c({ id: 11, status: 'planned', created_at: '2026-09-10 10:00:00' })
    const p2 = c({ id: 12, status: 'planned', created_at: '2026-09-10 10:00:00' })

    // Same second ⇒ the id breaks the tie (CLAUDE.md: `created_at` is
    // second-resolution, single-row picks need `, id DESC`).
    expect(ps.resolveLanding([open, p1, p2], TODAY).nextCycle.id).toBe(12)
    // ⚠ And it is filled even while a round is OPEN — the locked state's
    // „Ďalšia objednávka …" banner needs it as much as the closed state does.
    expect(ps.resolveLanding([open, p1], TODAY).state).toBe('open')
    expect(ps.resolveLanding([open, p1], TODAY).nextCycle.id).toBe(11)
    expect(ps.resolveLanding([open], TODAY).nextCycle).toBeNull()
  })

  test('⚠ `nextText` DELEGATES to 17\'s `nextOpeningText` — it is not a second copy', () => {
    // ⚠ THE DISCRIMINATING ASSERTION OF THIS ROW. §UC-PI-002 specifies the same
    // three branches module 17 shipped yesterday, but with `fmtDayMonth`
    // („približne 3. 10.") where 17 renders `fmtDay` („približne 3. októbra").
    // A re-implementation following 18's letter therefore produces a DIFFERENT
    // string, so byte-equality against 17's builder is proof of delegation and
    // not a tautology. The date-format conflict itself is recorded as a PO
    // question in `docs/learnings/10-portal-ia.md` — it is not resolved here.
    const cases = [
      [c({ id: 1, status: 'planned', opens_at: '2026-10-03' })],
      [c({ id: 1, status: 'planned', opens_at: '2026-09-21' })],
      [c({ id: 1, status: 'planned', plan_note: 'Asi po prázdninách.' })],
      [c({ id: 1, status: 'planned', opens_at: 'nonsense', plan_note: 'Dáme vedieť v lete.' })],
      [c({ id: 1, status: 'completed' })],
      [],
    ]
    for (const cycles of cases) {
      const r = ps.resolveLanding(cycles, TODAY)
      expect(r.nextText, JSON.stringify(cycles)).toBe(cs.nextOpeningText(r.nextCycle, TODAY).text)
    }

    // The three branches, spelled out so the delegation above is anchored to real
    // copy rather than to whatever both sides happen to return.
    expect(ps.resolveLanding(cases[0], TODAY).nextText)
      .toBe('Ďalšia objednávka sa otvorí približne 3. októbra (o 2 týždne).')
    expect(ps.resolveLanding(cases[2], TODAY).nextText).toBe('Asi po prázdninách.')
    expect(ps.resolveLanding(cases[5], TODAY).nextText).toBe('O ďalšej objednávke dáme vedieť.')
    // A malformed `opens_at` falls THROUGH to the note — never „približne ." with
    // a hole in it (CS-T2's branch-1 gate, inherited for free by delegating).
    expect(ps.resolveLanding(cases[3], TODAY).nextText).toBe('Dáme vedieť v lete.')
  })

  test('junk in ⇒ a `closed` landing out, never a throw', () => {
    for (const bad of [null, undefined, 'abc', 42, {}, [null], [{}], [{ status: 'nonsense' }]]) {
      const r = ps.resolveLanding(bad, TODAY)
      expect(r.state, JSON.stringify(bad)).toBe('closed')
      expect(r.currentCycle).toBeNull()
      expect(r.nextCycle).toBeNull()
      expect(r.nextText).toBe('O ďalšej objednávke dáme vedieť.')
    }
  })
})

test.describe('PI-T1 · 18 §UC-PI-002 — `lib/dates.js`, the short forms', () => {
  test.skip(!HAS_SRC, NEEDS_SRC)

  let d = null
  const TODAY = new Date('2026-09-20T12:00:00')
  test.beforeAll(async () => { d = await import(pathToFileURL(LIB_DATES).href) })

  test('the three formats are the spec\'s', () => {
    expect(d.fmtDayMonth('2026-09-12')).toBe('12. 9.')
    expect(d.fmtDayMonth('2026-10-03')).toBe('3. 10.')
    expect(d.fmtDate('2026-09-12')).toBe('12. 9. 2026')
    // 2026-09-11 is a Friday — the GENITIVE form, which ICU's `weekday: 'long'`
    // does not produce („piatok"), which is why the seven forms are spelled out.
    expect(d.fmtWeekdayDayMonth('2026-09-11')).toBe('piatku 11. 9.')
    expect(d.fmtWeekdayDayMonth('2026-09-12')).toBe('soboty 12. 9.')
    expect(d.fmtWeekdayDayMonth('2026-09-13')).toBe('nedele 13. 9.')
    expect(d.fmtWeekdayDayMonth('2026-09-14')).toBe('pondelka 14. 9.')
  })

  test('⚠ `2026-02-31` is 3 MARCH to V8 — the shape check alone is not validation', () => {
    // CS-T2 measured this: `new Date('2026-02-31T00:00:00')` is not Invalid Date,
    // so a `^\d{4}-\d{2}-\d{2}$` check would have printed a day nobody chose.
    expect(new Date('2026-02-31T00:00:00').getDate(), 'the trap is real on this runtime').toBe(3)
    expect(d.fmtDayMonth('2026-02-31')).toBe('2026-02-31')
    expect(d.fmtDate('2026-02-31')).toBe('2026-02-31')
    expect(d.weeksUntil('2026-02-31', TODAY)).toBeNull()
    // Non-vacuity: a REAL date one day earlier formats, so the refusal above is a
    // refusal and not a broken formatter.
    expect(d.fmtDayMonth('2026-02-28')).toBe('28. 2.')
  })

  test('an unparsable STRING renders raw; a non-string renders nothing', () => {
    // §UC-PI-002: „an unparsable value renders the raw string". ⚠ Deliberately the
    // OPPOSITE of `cycle-stages.js` `fmtDay()`, which returns '' — 17's builders
    // drop a bad date because they would compose a sentence around it; here the
    // date IS the rendered thing, so the stored value is the useful answer.
    for (const fn of ['fmtDayMonth', 'fmtDate', 'fmtWeekdayDayMonth']) {
      expect(d[fn]('kedykoľvek'), fn).toBe('kedykoľvek')
      expect(d[fn](''), fn).toBe('')
      expect(d[fn](null), fn).toBe('')
      expect(d[fn](undefined), fn).toBe('')
      expect(d[fn](20261003), fn).toBe('')
      expect(d[fn]({}), fn).toBe('')
    }
  })

  test('`weeksUntil` counts whole CALENDAR weeks and refuses the past', () => {
    expect(d.weeksUntil('2026-09-27', TODAY)).toBe(1)
    expect(d.weeksUntil('2026-10-11', TODAY)).toBe(3)
    expect(d.weeksUntil('2026-10-25', TODAY)).toBe(5)
    expect(d.weeksUntil('2026-09-23', TODAY), 'under a week rounds to 0, the caller omits the suffix').toBe(0)

    // ⚠ A NULL CLOCK IS NOT „now" — added in the PI-T1 review, before any caller
    // existed. `new Date(null)` and `new Date(0)` are VALID Dates at the epoch, not
    // Invalid, so a default-parameter guard alone let them through and this returned
    // **2961** (the weeks since 1970) instead of `null`. PI-T2's drawer sub-line and
    // PI-T4's „(o n týždňov)" are the intended callers, and a clock that has not
    // loaded yet is exactly the value that arrives as `null`. ⚠ `undefined` must STILL
    // mean „now" — that is the default parameter, and conflating the two would break
    // every caller that omits the argument.
    expect(d.weeksUntil('2026-10-03', null), 'a null clock is refused, not treated as the epoch').toBeNull()
    expect(d.weeksUntil('2026-10-03', 0), 'timestamp 0 is the epoch, not „now"').toBeNull()
    expect(d.weeksUntil('2026-10-03', 'junk'), 'an unparsable clock is refused').toBeNull()
    expect(typeof d.weeksUntil('2026-10-03'), 'but an OMITTED clock still means now').toBe('number')
    expect(d.weeksUntil('2026-09-20', TODAY), 'today').toBeNull()
    expect(d.weeksUntil('2026-09-19', TODAY), 'yesterday').toBeNull()
  })

  test('⚠ a SPRING-FORWARD boundary does not shift the week count', () => {
    // ⚠ THIS FIXTURE WAS CHOSEN BY MUTATION, NOT BY INTUITION, and the first one
    // was a FIXED POINT — the seventh in this module family. Three things have to
    // line up before naive `getTime()` subtraction is visible at all:
    //
    //  1. a named zone. This box runs UTC, where the naive arithmetic and the UTC
    //     round-trip are IDENTICAL (CS-T2 §4): an assertion that does not NAME a
    //     timezone measures nothing.
    //  2. clocks FORWARD, not back. Europe/Bratislava's autumn change (2026-10-25)
    //     makes the naive raw value LARGER, and with a midday `today` it rounds to
    //     the same day count — the first draft of this test used it and stayed
    //     GREEN under the mutation.
    //  3. a day count that straddles the WEEK rounding. `Math.round(days / 7)`
    //     absorbs a one-day error almost everywhere; 11 → 2 and 10 → 1 is one of
    //     the few places it does not.
    //
    // 2026-03-29 is the spring change. 2026-03-22 12:00 → 2026-04-02 is 11 calendar
    // days; naive local subtraction measures 10.46 and answers ONE week.
    const previous = process.env.TZ
    process.env.TZ = 'Europe/Bratislava'
    try {
      const before = new Date('2026-03-22T12:00:00')
      expect(d.weeksUntil('2026-04-02', before), 'eleven calendar days is two weeks').toBe(2)
      // Non-vacuity, same zone, one day either side — so the line above is about
      // the boundary and not about a function that answers 2 for everything.
      expect(d.weeksUntil('2026-04-01', before)).toBe(1)
      expect(d.weeksUntil('2026-04-09', before)).toBe(3)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })

  test('⚠ the DISPLAY day never slides in a negative-offset zone', () => {
    // The other half of the same rule, and it needs its own zone: validation goes
    // through UTC, DISPLAY is built from LOCAL midnight (CS-T2 §3). Format the UTC
    // instant instead and New York prints the PREVIOUS day — measured: `11. 9.`
    // and weekday index 5 (piatku) instead of 6 (soboty).
    const previous = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      expect(d.fmtDayMonth('2026-09-12')).toBe('12. 9.')
      expect(d.fmtDate('2026-09-12')).toBe('12. 9. 2026')
      expect(d.fmtWeekdayDayMonth('2026-09-12'), 'the weekday slides with the day').toBe('soboty 12. 9.')
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. ONE HOME — the source pins this row exists to protect
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T1 · one home — no second copy of module 17, no state in the parent', () => {
  test.skip(!HAS_SRC, NEEDS_SRC)

  const read = (p) => readFileSync(join(FRONTEND_SRC, p), 'utf8')
  /** Source with comments stripped — a rule about CODE must not read prose. */
  const code = (p) => read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')

  test('`portal-state.js` formats no date and sorts no cycle of its own', () => {
    const src = code('lib/portal-state.js')
    expect(src.length, 'the file was read').toBeGreaterThan(200)
    // The sentence and its date form are 17's; the „newest" sort is 17's.
    for (const forbidden of ['fmtDay', 'toLocaleDateString', 'created_at', 'Ďalšia objednávka', 'približne', 'sort(']) {
      expect(src, `\`${forbidden}\` must not appear in portal-state.js`).not.toContain(forbidden)
    }
    // …and it says so by IMPORTING them.
    expect(src).toMatch(/import \{[^}]*nextOpeningText[^}]*\} from '\.\/cycle-stages\.js'/)
    expect(src).toMatch(/import \{[^}]*currentCycleFor[^}]*\} from '\.\/cycle-stages\.js'/)
  })

  test('⚠ `resolveLanding` is reachable from exactly one place, and it is the SESSION', () => {
    // The session-boundary hard rule, at source level. `FriendPortal.vue` owns
    // the auth handshake and outlives the session; anything module 18 adds there
    // would survive a logout and greet the next friend.
    const parent = code('views/FriendPortal.vue')
    expect(parent.length, 'the parent was read').toBeGreaterThan(1000)
    for (const forbidden of ['resolveLanding', 'portal-state', 'portal-landing', 'route.meta']) {
      expect(parent, `\`${forbidden}\` must not appear in FriendPortal.vue`).not.toContain(forbidden)
    }
    const session = code('views/FriendPortalSession.vue')
    expect(session).toContain('resolveLanding')
    expect(session).toContain('portal-landing')
    // ⚠ `<script setup>` has NO module scope (CLAUDE.md): a plain `<script>` block
    // is exactly where a singleton/cache would outlive the `:key` remount.
    expect(session, 'no plain <script> block may appear here').not.toMatch(/<script(?!\s+setup)[^>]*>/)
    // …and nothing this row adds may be persisted.
    expect(session.split('resolveLanding')[0]).not.toContain('localStorage.setItem')
  })

  test('the four routes all mount `FriendPortal.vue`, each with its own `meta.view`', () => {
    const src = read('router.js')
    const entries = [...src.matchAll(/path: '([^']+)'[\s\S]{0,400}?meta: \{ view: '([^']+)' \}/g)]
      .map((m) => [m[1], m[2]])
    expect(entries).toEqual([
      ['/', 'shop'],
      ['/moje-objednavky', 'history'],
      ['/zostatok', 'balance'],
      ['/ako-to-funguje', 'explainer'],
    ])
    // ⚠ `/cycle/:cycleId` is the DEEP LINK (§UC-PI-018), a standalone screen — it
    // must NOT acquire a `meta.view` and become a fifth portal view. Read as the
    // text of its own route entry, up to the closing brace.
    const deepLink = src.slice(src.indexOf("path: '/cycle/:cycleId'"))
    expect(deepLink.startsWith("path: '/cycle/:cycleId'"), 'the deep-link route exists').toBe(true)
    const entry = deepLink.slice(0, deepLink.indexOf('\n  }'))
    expect(entry).toContain("component: () => import('./views/FriendOrder.vue')")
    expect(entry, 'the deep link is not a portal view').not.toContain('meta')
  })

  test('⚠ no ADMIN view imports the three module-18 libs (02 UC-DS-014 admin invariance)', () => {
    // §UC-PI-019 item 18, asserted early because it is cheapest to keep true.
    const adminish = ['views/CycleDetail.vue', 'views/Distribution.vue', 'views/AdminDashboard.vue',
      'views/AdminFriends.vue', 'views/AdminSettings.vue', 'views/FriendDetail.vue']
    let checked = 0
    for (const f of adminish) {
      if (!existsSync(join(FRONTEND_SRC, f))) continue
      checked += 1
      const src = read(f)
      expect(src, f).not.toMatch(/lib\/(portal-state|dates)/)
    }
    expect(checked, 'admin views were actually read').toBeGreaterThan(3)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. §UC-PI-002 backend — `GET /friends/cycles`, ADDITIVE
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T1 · 18 §UC-PI-002 — the friend cycles payload extension', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.friend = await makeFriend('Payload')

    const made = await admin('/api/cycles', {
      method: 'post', data: { name: `E2E PI1 Payload ${uniq}`, type: 'coffee', status: 'open' },
    })
    expect(made.status(), 'cycle create').toBe(201)
    fx.cycle = await made.json()
    // `parcel_*` and the two dates are PATCH-only on this router.
    const patched = await admin(`/api/cycles/${fx.cycle.id}`, {
      method: 'patch',
      data: { parcel_enabled: true, parcel_fee: 3.9, opens_at: '2026-12-01', closes_at: '2026-12-20' },
    })
    expect(patched.status(), 'cycle patch').toBe(200)

    const product = await admin('/api/products', {
      method: 'post',
      data: {
        cycle_id: fx.cycle.id, name: `PI1 Kava ${uniq}`, purpose: 'Espresso',
        roast_type: 'Svetlé', price_250g: 10, price_1kg: 30,
      },
    })
    expect(product.status(), 'product create').toBe(201)
    fx.product = await product.json()

    const loc = await admin('/api/pickup-locations', {
      method: 'post',
      data: { name: `PI1 Miesto ${uniq}`, address: 'Testovacia 1', for_coffee: true, for_bakery: true },
    })
    expect(loc.status(), 'pickup location create').toBe(201)
    fx.location = await loc.json()

    const put = await ctx.put(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.friend.id}`, {
      headers: fx.friend.auth, data: { items: [{ product_id: fx.product.id, variant: '250g', quantity: 2 }] },
      timeout: TIMEOUT,
    })
    expect(put.status(), 'cart PUT').toBe(200)
    const submit = await ctx.post(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.friend.id}/submit`, {
      headers: fx.friend.auth, data: { pickup_location_id: fx.location.id }, timeout: TIMEOUT,
    })
    expect(submit.status(), 'submit').toBe(200)
    fx.order = (await submit.json()).order
  })

  /** The friend's own view of their cycles — the endpoint under test. */
  async function friendCycles() {
    const res = await ctx.get(`/api/friends/cycles?friendId=${fx.friend.id}`, {
      headers: fx.friend.auth, timeout: TIMEOUT,
    })
    expect(res.status(), 'friend cycles').toBe(200)
    return res.json()
  }
  const mine = (list) => list.find((c) => c.id === fx.cycle.id)

  test('the five cycle columns ride the payload with their stored values', async () => {
    const cycle = mine(await friendCycles())
    expect(cycle, 'the fixture cycle is in the friend payload').toBeTruthy()
    expect({
      opens_at: cycle.opens_at, closes_at: cycle.closes_at, stage: cycle.stage,
      parcel_enabled: cycle.parcel_enabled, parcel_fee: cycle.parcel_fee,
    }).toEqual({
      opens_at: '2026-12-01', closes_at: '2026-12-20', stage: null,
      parcel_enabled: 1, parcel_fee: 3.9,
    })
  })

  test('⚠ `orderPaid` / `orderHandedOver` track the real columns, both ways', async () => {
    // ⚠ BOTH DEFAULT TO `false`, which is exactly why a default-only assertion
    // proves nothing: a route that read neither column would satisfy it. So each
    // flag is driven through its REAL admin route and read back on both edges.
    let cycle = mine(await friendCycles())
    expect({ paid: cycle.orderPaid, handed: cycle.orderHandedOver }).toEqual({ paid: false, handed: false })

    // Hand-over needs a packed bag first (16 §UC-DP-003, PO Q8.a).
    const dist = await admin(`/api/cycles/${fx.cycle.id}/distribution`)
    expect(dist.status(), 'distribution').toBe(200)
    const party = (await dist.json()).distribution.find((p) => p.id === fx.friend.id)
    expect(party, 'the friend is a party on the board').toBeTruthy()
    for (const item of party.items) {
      expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
    }
    expect((await admin(`/api/orders/${fx.order.id}/packed`, { method: 'patch' })).status()).toBe(200)
    expect((await admin(`/api/orders/${fx.order.id}/handed-over`, {
      method: 'patch', data: { handed_over: true },
    })).status()).toBe(200)

    cycle = mine(await friendCycles())
    expect(cycle.orderHandedOver, 'a handed-over bag reads true').toBe(true)
    expect(cycle.orderPaid, 'hand-over is not a payment').toBe(false)

    expect((await admin(`/api/orders/${fx.order.id}/paid`, { method: 'patch', data: { paid: true } })).status()).toBe(200)
    cycle = mine(await friendCycles())
    expect({ paid: cycle.orderPaid, handed: cycle.orderHandedOver }).toEqual({ paid: true, handed: true })

    // …and back. An un-hand-over must flip the flag, not merely stop writing it.
    expect((await admin(`/api/orders/${fx.order.id}/handed-over`, {
      method: 'patch', data: { handed_over: false },
    })).status()).toBe(200)
    expect((await admin(`/api/orders/${fx.order.id}/paid`, { method: 'patch', data: { paid: false } })).status()).toBe(200)
    cycle = mine(await friendCycles())
    expect({ paid: cycle.orderPaid, handed: cycle.orderHandedOver }).toEqual({ paid: false, handed: false })
  })

  test('a cycle the friend never ordered from reads `false` for both, and `hasOrder` false', async () => {
    const made = await admin('/api/cycles', {
      method: 'post', data: { name: `E2E PI1 Foreign ${uniq}`, type: 'coffee', status: 'open' },
    })
    expect(made.status(), 'cycle create').toBe(201)
    const other = (await made.json()).id

    const row = (await friendCycles()).find((c) => c.id === other)
    expect(row, 'the foreign cycle is listed').toBeTruthy()
    expect({ hasOrder: row.hasOrder, paid: row.orderPaid, handed: row.orderHandedOver })
      .toEqual({ hasOrder: false, paid: false, handed: false })
  })

  test('⚠ NOTHING ELSE MOVED: the ordering, the placeholder exclusion, the money rounding', async () => {
    // The extension is ADDITIVE (§UC-PI-002) — these are the shipped properties a
    // careless SELECT edit takes out, so they are re-asserted beside it.
    const list = await friendCycles()
    expect(list.length, 'the list is not empty').toBeGreaterThan(0)

    expect(list.some((c) => c.name === '_placeholder'), 'the placeholder stays excluded').toBe(false)

    // ⚠ NON-INCREASING, not "equals a sorted copy": `created_at` is
    // second-resolution and SQLite leaves the order of TIES unspecified, so a
    // re-sorted comparison would flake on two cycles created in the same second.
    const stamps = list.map((c) => String(c.created_at || ''))
    const descending = stamps.every((s, i) => i === 0 || stamps[i - 1] >= s)
    expect(descending, `ORDER BY c.created_at DESC still holds: ${JSON.stringify(stamps)}`).toBe(true)
    expect(stamps.length, 'more than one cycle, so the ordering claim is a claim').toBeGreaterThan(1)

    const ordered = mine(list)
    // `orderTotal` is `roundMoney(total + delivery_fee)` — a SUM OF TWO MONEY
    // COLUMNS, which is where 33.56 + 4.20 became 37.760000000000005.
    expect(Number.isFinite(ordered.orderTotal)).toBe(true)
    expect(ordered.orderTotal, 'still rounded server-side').toBe(Math.round(ordered.orderTotal * 100) / 100)
    expect(ordered.hasOrder).toBe(true)
    expect(ordered.orderStatus).toBe('submitted')
  })

  test('the subscription filter block is untouched — a subscribed friend still sees their own round', async () => {
    // §UC-PI-002: R2.5 retires the filter from the UI only; the endpoint keeps it.
    const put = await ctx.put(`/api/subscriptions/friend/${fx.friend.id}`, {
      headers: fx.friend.auth, data: { types: ['bakery'] }, timeout: TIMEOUT,
    })
    expect(put.status(), 'subscriptions PUT still answers 200').toBe(200)
    try {
      const list = await friendCycles()
      // „always show cycles where the friend has an order" — the coffee round they
      // ordered from survives a bakery-only subscription…
      expect(mine(list), 'the ordered coffee round survives the filter').toBeTruthy()
      // …and the coffee round they did NOT order from is filtered out, which is
      // what makes the line above a claim about the FILTER and not about a no-op.
      expect(list.some((c) => c.name === `E2E PI1 Foreign ${uniq}`),
        'an un-ordered coffee round IS filtered out').toBe(false)
    } finally {
      await ctx.put(`/api/subscriptions/friend/${fx.friend.id}`, {
        headers: fx.friend.auth, data: { types: [] }, timeout: TIMEOUT,
      })
    }
  })
})
