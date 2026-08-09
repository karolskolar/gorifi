import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-FL-5 — the open-cycle card's share row (03 §UC-FL-007): the colleague-count
// context on the left, the `btn.sm` share entry point on the right, and the
// non-blocking, sequence-guarded count fetch behind it.
//
// ⚠ HERMETIC, per the idiom `portal-cycles.spec.js` / `portal-appbar.spec.js`
// established: this file writes NO global server state beyond the one friend it
// provisions for itself. Cycles are GLOBAL, so every card state is a per-page
// `page.route` stub of `GET /api/friends/cycles`; the colleague counts are a
// per-page stub of `GET /api/guest-links/cycle/:id`, which is what lets the
// sequence guard be DEMONSTRATED (a deferred fulfil) rather than asserted.
//
// ⚠ The dialog's internals are module 05's (RD-KG-2). This file only asserts the
// ENTRY contract: it opens, it names the cycle it shares, and it does not
// navigate. `guest-link.spec.js` remains the primary pin for the button's
// accessible name and its absence on locked cards, and is not edited here.

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let friend = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  const username = `rdfl5_${uniq}`.slice(0, 30)
  const name = `RDFL5 Tester ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()

  // An admin reset raises must_change_password; clear it so the portal is not
  // gated by the forced-change modal.
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)

  friend = { id: row.id, name, username, token: (await changed.json()).token || body.token }
})

test.afterAll(async () => { await ctx?.dispose() })

// ---------------------------------------------------------------------------
// Fixtures — `GET /api/friends/cycles`'s verbatim shape
// (`backend/src/routes/friends.js`).

const cycleRow = (over) => ({
  id: 0,
  name: '',
  status: 'open',
  created_at: '2026-08-01 10:00:00',
  total_friends: 12,
  expected_date: '29. august 2026',
  type: 'coffee',
  plan_note: null,
  hasOrder: false,
  orderTotal: 0,
  orderStatus: null,
  orderKilos: 0,
  orderItemCount: 0,
  orderPickupName: null,
  orderPacketa: false,
  ...over,
})

const IDS = { openA: 9201, openB: 9202, locked: 9203, planned: 9204 }

const NAMES = {
  openA: `RDFL5 Open With Colleagues ${uniq}`,
  openB: `RDFL5 Open Alone ${uniq}`,
  locked: `RDFL5 Locked ${uniq}`,
  planned: `RDFL5 Planned ${uniq}`,
}

const MATRIX = [
  cycleRow({ id: IDS.openA, name: NAMES.openA, status: 'open' }),
  cycleRow({ id: IDS.openB, name: NAMES.openB, status: 'open' }),
  cycleRow({ id: IDS.locked, name: NAMES.locked, status: 'locked' }),
  cycleRow({ id: IDS.planned, name: NAMES.planned, status: 'planned' }),
]

/** The GSO-T2 `{ link, guest_orders, totals }` payload, trimmed to what the row reads. */
const linkPayload = (count) => ({
  link: { id: 1, token: 'E2ERDFL5TOKEN', host_friend_id: 0, cycle_id: 0, active: 1 },
  guest_orders: [],
  totals: { count, total: count * 4.2 },
})

/** Sign in the way "remember me" does — a REAL session token, nothing stubbed. */
async function signIn(page) {
  const stored = JSON.stringify({
    friendId: friend.id,
    friendName: friend.name,
    token: friend.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, stored)
}

async function stubCycles(page, cycles = MATRIX) {
  await page.route('**/api/friends/cycles*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(cycles),
  }))
}

async function stubBalance(page, balance = -74.24) {
  await page.route('**/api/friends/*/balance', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ balance, transactions: [] }),
  }))
}

/**
 * Colleague counts per cycle id. A cycle absent from `counts` is answered with a
 * 500 — the "the fetch failed" half of UC-FL-007's fallback rule, which must be
 * indistinguishable on screen from "no colleagues yet".
 */
async function stubCounts(page, counts) {
  await page.route('**/api/guest-links/cycle/*', (route) => {
    const id = Number(route.request().url().split('/').pop())
    if (!(id in counts)) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linkPayload(counts[id])) })
  })
}

async function openPortal(page, { cycles = MATRIX, counts = {} } = {}) {
  await signIn(page)
  await stubBalance(page)
  await stubCycles(page, cycles)
  await stubCounts(page, counts)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
}

/** `guest-link.spec.js:301`'s locator, verbatim. */
const cardFor = (page, name) => page.locator('div.p-4', { has: page.getByRole('heading', { name, exact: true }) })
const rowFor = (page, name) => cardFor(page, name).getByTestId('share-row')
const shareBtn = (page, name) => cardFor(page, name).getByRole('button', { name: 'Zdieľať s kolegami' })

// ---------------------------------------------------------------------------

test.describe('Share row — the two count states (UC-FL-007)', () => {
  test('≥1 non-cancelled sub-order renders the mono badge + "kolegovia cez váš odkaz"', async ({ page }) => {
    await openPortal(page, { counts: { [IDS.openA]: 3 } })

    const row = rowFor(page, NAMES.openA)
    await expect(row).toContainText('kolegovia cez váš odkaz')
    await expect(row).not.toContainText('Objednávate aj pre kolegov?')

    // `.tabbadge` is the theme's mono, bordered, pill-shaped chip.
    const badge = row.locator('.tabbadge')
    await expect(badge).toHaveText('3')
    await expect(badge).toHaveCSS('border-radius', '999px')
    await expect(badge).toHaveCSS('border-width', '2px')
    const font = await badge.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(font, 'the count is mono').toMatch(/Courier/i)
  })

  test('no colleagues — and a FAILED fetch — both render "Objednávate aj pre kolegov?" with no badge', async ({ page }) => {
    // openB is stubbed with count 0; `locked`/`planned` never fetch at all, and
    // openA is deliberately NOT in the map, so its request 500s.
    await openPortal(page, { counts: { [IDS.openB]: 0 } })

    for (const name of [NAMES.openA, NAMES.openB]) {
      const row = rowFor(page, name)
      await expect(row).toContainText('Objednávate aj pre kolegov?')
      await expect(row.locator('.tabbadge'), 'no badge when the count is 0 or unknown').toHaveCount(0)
    }

    // ⚠ A failed count must never surface as the page's error banner — the row
    // IS the failure state.
    await expect(page.locator('.banner.danger')).toHaveCount(0)
  })

  test('the count fetch hits GET /guest-links/cycle/:id for OPEN cycles only', async ({ page }) => {
    const asked = []
    await signIn(page)
    await stubBalance(page)
    await stubCycles(page)
    await page.route('**/api/guest-links/cycle/*', (route) => {
      asked.push(Number(route.request().url().split('/').pop()))
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linkPayload(1)) })
    })
    await page.goto('/')
    await expect(rowFor(page, NAMES.openA).locator('.tabbadge')).toHaveText('1')
    await expect(rowFor(page, NAMES.openB).locator('.tabbadge')).toHaveText('1')

    expect(asked.slice().sort(), JSON.stringify(asked)).toEqual([IDS.openA, IDS.openB])
  })
})

// ---------------------------------------------------------------------------

test.describe('Share row — structure, geometry and absence (UC-FL-007)', () => {
  // ⚠ Not verifiable against `screenshots/02-shot.png` — that frame crops mid-card
  // immediately after the plan block and never reaches this row. Every value below
  // comes from 03 §UC-FL-007 §Structure and from `friends/portal.jsx:73-81`, the
  // source the shot was rendered from.
  test('the row matches 03 §UC-FL-007 at 378px: 2px rule, 12px above and below, btn.sm + "Zdieľať"', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await openPortal(page, { counts: { [IDS.openA]: 3 } })

    const row = rowFor(page, NAMES.openA)
    await expect(row).toHaveCSS('border-top-width', '2px')
    await expect(row).toHaveCSS('border-top-style', 'solid')
    await expect(row).toHaveCSS('border-top-color', 'rgba(10, 10, 10, 0.12)')
    await expect(row).toHaveCSS('padding-top', '12px')
    await expect(row).toHaveCSS('margin-top', '12px')
    await expect(row).toHaveCSS('display', 'flex')
    await expect(row).toHaveCSS('align-items', 'center')
    await expect(row).toHaveCSS('justify-content', 'space-between')

    const btn = shareBtn(page, NAMES.openA)
    // ⚠ resolved conflict #2: VISIBLE "Zdieľať" (prototype) + accessible name
    // "Zdieľať s kolegami" (the `guest-link.spec.js` pin). Both, not either.
    await expect(btn).toHaveText('Zdieľať')
    await expect(btn).toHaveAttribute('aria-label', 'Zdieľať s kolegami')
    await expect(btn.locator('svg'), 'the share glyph').toHaveCount(1)
    await expect(btn).toHaveClass(/\bbtn\b/)
    await expect(btn).toHaveClass(/\bsm\b/)
    // `.btn.sm` metrics from the theme (02 §A9 keeps Tailwind preflight off them).
    await expect(btn).toHaveCSS('border-width', '3px')
    await expect(btn).toHaveCSS('font-size', '13px')
    const box = await btn.boundingBox()
    expect(box.height, 'btn.sm is 38px tall').toBeGreaterThanOrEqual(38)

    // The row is the card's LAST child, directly under the badge row — the
    // geometry RD-FL-4's seam comment promised.
    const tail = await cardFor(page, NAMES.openA).evaluate((card) => {
      const kids = Array.from(card.children)
      return {
        lastIsRow: kids[kids.length - 1].getAttribute('data-testid') === 'share-row',
        prevHasBadges: kids[kids.length - 2].querySelectorAll('.badge').length > 0,
      }
    })
    expect(tail.lastIsRow, JSON.stringify(tail)).toBe(true)
    expect(tail.prevHasBadges, JSON.stringify(tail)).toBe(true)
  })

  test('locked and planned cycles carry no row and no share affordance', async ({ page }) => {
    await openPortal(page, { counts: { [IDS.openA]: 3 } })

    for (const name of [NAMES.locked, NAMES.planned]) {
      await expect(cardFor(page, name), `${name} renders`).toHaveCount(1)
      await expect(rowFor(page, name), `${name} has no share row`).toHaveCount(0)
      await expect(shareBtn(page, name), `${name} offers no share affordance`).toHaveCount(0)
      await expect(cardFor(page, name)).not.toContainText('Objednávate aj pre kolegov?')
    }

    await expect(page.getByTestId('share-row'), 'exactly one row per open cycle').toHaveCount(2)
  })

  test('no horizontal overflow at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await openPortal(page, { counts: { [IDS.openA]: 12 } })
    await expect(rowFor(page, NAMES.openA).locator('.tabbadge')).toHaveText('12')

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth)
  })
})

// ---------------------------------------------------------------------------

test.describe('Share row — the dialog entry contract (UC-FL-007)', () => {
  test('@click.stop opens the dialog for THAT cycle without navigating', async ({ page }) => {
    await openPortal(page, { counts: { [IDS.openA]: 3, [IDS.openB]: 0 } })

    await shareBtn(page, NAMES.openB).click()
    // ⚠ The card root navigates on click; without `.stop` the portal would be
    // gone before the dialog could be read.
    await expect(page).toHaveURL(/\/$/)

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // The dialog names the cycle it shares (GSO-T2 rule) — several open cycles
    // sit side by side, so an unlabelled URL cannot be verified.
    await expect(dialog).toContainText(NAMES.openB)
    await expect(dialog, 'the OTHER open cycle is not the one being shared').not.toContainText(NAMES.openA)

    // ONE instance for the whole view: closing and reopening from the other card
    // re-targets the same dialog rather than stacking a second one.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await shareBtn(page, NAMES.openA).click()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.getByRole('dialog')).toContainText(NAMES.openA)
  })

  test('the count is context only — it gates nothing on this screen', async ({ page }) => {
    // A cycle whose count fetch fails still shares, still navigates, still shows
    // its order state. Nothing on the card depends on the number.
    await openPortal(page, { counts: {} })

    await expect(rowFor(page, NAMES.openA)).toContainText('Objednávate aj pre kolegov?')
    await expect(shareBtn(page, NAMES.openA)).toBeEnabled()
    await cardFor(page, NAMES.openA).getByRole('heading', { name: NAMES.openA, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/cycle/${IDS.openA}$`))
  })
})

// ---------------------------------------------------------------------------

test.describe('⚠ Session scoping and the sequence guard (UC-FL-007)', () => {
  /**
   * Renders the modern login card so a session can END and RESTART without a
   * reload — RD-FL-2's idiom; the seed stays legacy. A reload would remount the
   * view and re-init the refs regardless, making these tests pass against the
   * very bug they exist for.
   */
  async function stubModernAuthMode(page) {
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'modern' } }))
  }

  async function logOut(page) {
    await page.locator('.appbar span[aria-label="Odhlásiť sa"]').click()
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
  }

  async function logBackIn(page) {
    await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
    await page.getByLabel(/^heslo$/i).fill('ownPass12')
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  }

  test('counts do NOT survive a logout into the next session (no reload)', async ({ page }) => {
    // A stale count is not a cosmetic leak: it is the PREVIOUS host's colleague
    // data, on a device the two of them share.
    await stubModernAuthMode(page)
    await signIn(page)
    await stubBalance(page)
    await stubCycles(page)

    let serve = true
    await page.route('**/api/guest-links/cycle/*', (route) => (serve
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linkPayload(4)) })
      : route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })))

    await page.goto('/')
    await expect(rowFor(page, NAMES.openA).locator('.tabbadge')).toHaveText('4')

    // The next session's own fetch fails, so the ONLY way a number can appear is
    // if the previous session's map survived.
    serve = false
    await logOut(page)
    await logBackIn(page)

    await expect(rowFor(page, NAMES.openA)).toContainText('Objednávate aj pre kolegov?')
    await expect(rowFor(page, NAMES.openA).locator('.tabbadge')).toHaveCount(0)
  })

  test('⚠ a response deferred past a LOGOUT is dropped, not written', async ({ page }) => {
    // Demonstrated, not asserted: the first request is held open until after the
    // session has ended and a new one has begun. `switchUser` clears the map
    // BEFORE that response lands, so the sequence guard is the only thing
    // between it and the next friend's screen.
    await stubModernAuthMode(page)
    await signIn(page)
    await stubBalance(page)
    await stubCycles(page)

    // ⚠ The deferral is keyed on the CYCLE, not on call order: two open cycles
    // fetch concurrently, so "the first call" is a race and could hold the wrong
    // one open. `deferredLanded` resolves only once the held response has
    // actually been fulfilled, so the assertion below cannot run too early.
    let calls = 0
    let deferredSent = false
    let resolveDeferred
    const deferredLanded = new Promise((resolve) => { resolveDeferred = resolve })

    await page.route('**/api/guest-links/cycle/*', async (route) => {
      calls += 1
      const id = Number(route.request().url().split('/').pop())
      if (id === IDS.openA && !deferredSent) {
        deferredSent = true
        await new Promise((resolve) => setTimeout(resolve, 2500))
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linkPayload(7)) })
        resolveDeferred()
        return
      }
      // Every later fetch yields nothing, so a "7" on screen can only have come
      // from the deferred response.
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    // Still in flight → the fallback, not a badge.
    await expect(rowFor(page, NAMES.openA)).toContainText('Objednávate aj pre kolegov?')

    await logOut(page)
    await logBackIn(page)

    // Let the first session's response land on the SECOND session's screen.
    await deferredLanded
    await page.waitForTimeout(500)

    await expect(
      rowFor(page, NAMES.openA),
      "a stale response must not write another session's colleague count"
    ).toContainText('Objednávate aj pre kolegov?')
    await expect(rowFor(page, NAMES.openA).locator('.tabbadge')).toHaveCount(0)
    expect(calls, 'the second session did fetch — it just got nothing').toBeGreaterThan(1)
  })

  test('⚠ a response deferred past a SECOND loadCycles (same session) is dropped', async ({ page }) => {
    // The in-session half of the same rule: saving subscriptions re-runs
    // `loadCycles`, which bumps the sequence. The batch it superseded must not
    // land on top of the fresh list.
    await signIn(page)
    await stubBalance(page)
    await stubCycles(page)
    await page.route('**/api/subscriptions/friend/*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ types: ['coffee', 'bakery'] }),
    }))

    let calls = 0
    let deferredSent = false
    let resolveDeferred
    const deferredLanded = new Promise((resolve) => { resolveDeferred = resolve })

    await page.route('**/api/guest-links/cycle/*', async (route) => {
      calls += 1
      const id = Number(route.request().url().split('/').pop())
      if (id === IDS.openA && !deferredSent) {
        deferredSent = true
        await new Promise((resolve) => setTimeout(resolve, 2500))
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linkPayload(9)) })
        resolveDeferred()
        return
      }
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    await expect(rowFor(page, NAMES.openA)).toContainText('Objednávate aj pre kolegov?')

    await page.getByRole('button', { name: 'Nastavenia odberu' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await deferredLanded
    await page.waitForTimeout(500)

    await expect(
      rowFor(page, NAMES.openA),
      'a superseded batch must not land on the refetched list'
    ).toContainText('Objednávate aj pre kolegov?')
    await expect(rowFor(page, NAMES.openA).locator('.tabbadge')).toHaveCount(0)
    expect(calls, 'the refetch did re-request the counts').toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------

test.describe('⚠ The colleague-count fan-out is BOUNDED (RD-FL-8a item 3)', () => {
  // The batch used to `Promise.all` one `GET /api/guest-links/cycle/:id` per OPEN
  // cycle in a single tick, on an assumption written into the code — "typically
  // 1–2". Cycles are never auto-closed, so that decays silently with age: the
  // e2e database reaches 135 open cycles, and 135 XHRs issued at once queue
  // behind the browser's 6-connection-per-host limit with the portal's OWN
  // requests stuck behind them. It really happened, and flaked
  // `portal-session-boundary.spec.js` until `muteGuestCounts` was added.
  //
  // Two bounds are asserted, because either one alone is insufficient: a cap
  // still starves the portal if the batch is issued first, and ordering alone
  // still floods the connection pool.

  const MANY = 40
  const BULK = Array.from({ length: MANY }, (_, i) =>
    cycleRow({ id: 9600 + i, name: `RDFL8a Bulk ${i} ${uniq}`, status: 'open' })
  )

  test(`${MANY} open cycles: at most 3 count requests in flight, and never ahead of the portal's own`, async ({ page }) => {
    await signIn(page)
    await stubBalance(page)
    await page.route('**/api/friends/cycles*', (route) => route.fulfill({ json: BULK }))

    const order = []
    await page.route('**/api/subscriptions/friend/*', async (route) => {
      order.push('subs')
      return route.fulfill({ json: { types: [] } })
    })
    await page.route('**/api/vouchers/pending*', async (route) => {
      order.push('vouchers')
      return route.fulfill({ json: [] })
    })

    let inFlight = 0
    let peak = 0
    let served = 0
    await page.route('**/api/guest-links/cycle/*', async (route) => {
      order.push('count')
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // Long enough that an unbounded batch would pile every request up here.
      await new Promise((r) => setTimeout(r, 60))
      inFlight -= 1
      served += 1
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(linkPayload(2)) })
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()

    // Let the whole capped queue drain.
    await expect.poll(() => served, { timeout: 25_000 }).toBe(MANY)

    // 1. The cap. Unbounded, `peak` is MANY.
    expect(peak, `peak concurrent colleague-count requests (of ${MANY} cycles)`).toBeLessThanOrEqual(3)

    // 2. The ordering. Decoration must never be issued before the two fetches
    //    that decide what the screen shows.
    const firstCount = order.indexOf('count')
    expect(firstCount, 'the batch did run').toBeGreaterThan(-1)
    expect(order.indexOf('subs'), 'subscriptions are issued before any count').toBeLessThan(firstCount)
    expect(order.indexOf('vouchers'), 'the voucher check is issued before any count').toBeLessThan(firstCount)

    // …and the counts still land, so the bound did not simply drop them.
    await expect(rowFor(page, BULK[0].name).locator('.tabbadge')).toHaveText('2')
    await expect(rowFor(page, BULK[MANY - 1].name).locator('.tabbadge')).toHaveText('2')
  })
})
