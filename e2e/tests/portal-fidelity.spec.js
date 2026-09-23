import { test, expect, request as playwrightRequest } from '@playwright/test'
// PI-T1 · 18 §UC-PI-019 item 1 — the ONE home of the „portal is ready“ gate.
// It replaces this file's `getByRole('heading', { name: 'Objednávkové cykly' })`
// waits: that heading is a STRUCTURE module 18 retires (§UC-PI-005), so a gate
// tied to its copy could not survive the screen. Same claim, one home.
import { LANDING, expectLanding, openProfile } from '../helpers/portal.js'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

// RD-FL-8b — module 03's CLOSEOUT net (03 §UC-FL-013 procedure items 3 and 4).
//
// UC-FL-013 specifies fidelity and the 320px sweep as MANUAL checks "recorded in
// the PR — no visual CI". This file does not replace that judgement; it pins the
// two properties whose regression is SILENT and which modules 04–06 inherit,
// because they restyle screens built from the same primitives:
//
// (A) THE A9/A10 LINE-HEIGHT COUNTER IS IN FORCE.
//     `friends-theme.css` ports a canon that declares `line-height` on seven
//     classes and lets every other element compute the UA default `normal`;
//     Tailwind preflight's `html{line-height:1.5}` reaches all of them, so the
//     port needs an explicit counter. RD-FL-8b measured what it was still
//     missing, canon-vs-port at 378 and 1180 px, and every one of these was a
//     real drift on module 03's SHIPPED surface:
//
//       .ticker (every screen)  34 → 36     .neg (balance pill)  28 → 34
//       .display (order total)  24 → 27     .mono (archive sum)  15 → 18
//       login dashed footnote   82 → 94.75  archive toggle row   16 → 21
//       archive row name        18 → 22.5
//
//     `line-height: normal` is asserted EXACTLY — that is the mechanism, and it
//     is font-independent, so it cannot flake on a webfont metric. Heights carry
//     `neo-control-metrics.spec.js`'s 1px tolerance and only where a single,
//     non-wrapping line makes them stable.
//
//     ⚠ FOUR SITES CARRY NO THEME CLASS: the login footnote, the archive toggle
//     row, the archive row name, and the login remember-me label. A class list
//     cannot reach them, so they are fixed at the call site — which is exactly
//     the kind of fix that gets dropped by a later edit with nothing to notice.
//     They are pinned here. The remember-me label has no geometry delta today
//     (its 24px `.cbox` sibling dominates the flex line), so ONLY this pin
//     stands between it and silent drift the first time the pattern is reused.
//
// (B) 320 px WITH HOSTILE FREE TEXT — zero horizontal DOCUMENT overflow.
//     `mobile-no-h-overflow.spec.js` (pre-existing, unmodified) covers the ORDER
//     page. The portal has its own unbounded strings — the cycle name, the
//     admin's `plan_note` (RD-FL-4 found it needed `overflow-wrap`), the friend's
//     display name, the Packeta address, the invite URL — and no spec asserted
//     any of them. Every state below is fed a 120-char unbreakable token and a
//     pasted spreadsheet URL.
//
// (A2) PI-T12 · 18 §UC-PI-019 item 13 — MODULE 18's LANDING EQUIVALENTS of both: the
//     line-heights of the three landing states (plus „Moje objednávky" and „Zostatok a
//     platby", handed here by name), measured against the CANON rather than against
//     `normal` wherever the canon declares its own value, and a 320px hostile-text
//     pass per state — which found the state modal's footer scrolling the scrim with
//     no hostile text at all. Three shipped drifts and that overflow were fixed.
//
// ⚠ HERMETIC, per the `portal-share-row.spec.js` / `portal-cycles.spec.js`
// idiom: one friend of its own, every list stubbed per `page`, and — like
// `modern-login.spec.js` — `auth_mode` is NEVER written (the shared seed is
// legacy and other specs assert that); the modern login card is reached by
// stubbing `GET /friends/auth-mode` per page.

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let friend = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// The two shapes that actually turn up in free admin text: an unbreakable token
// and a pasted URL. Both defeat normal word wrapping.
const LONG_TOKEN = 'X'.repeat(120)
const LONG_URL = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj/edit#gid=0'

// The canon, measured in `docs/design/friends-portal-redesign/Podpultovka
// Friends.html` served over HTTP (file:// breaks it — Babel XHRs the .jsx),
// phone frame, fonts force-loaded before measuring.
// ⚠ ~~`negPill` is kept as the RECORD of the canon height, not as a live expectation~~
// — RETIRED by PI-T12, the decision PI-T7 handed it: PI-T7 removed the last `.neg.pill`
// from the app, so a constant nothing reads is not a record anyone consults. The record
// that IS consulted is `friends-theme.css` §A10's measurement table (`.neg 28 → 34`).
const CANON = { ticker: 34 }

const near = (actual, expected, what) =>
  expect(Math.abs(actual - expected), `${what}: got ${actual}, canon ${expected}`).toBeLessThanOrEqual(1)

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
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  const username = `rdfl8b_${uniq}`.slice(0, 30)
  const name = `RDFL8B Tester ${uniq}`
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
// Fixtures — `GET /api/friends/cycles`'s verbatim shape (backend/src/routes/friends.js)

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

const NAMES = {
  open: `RDFL8B Otvorený ${uniq}`,
  hostile: `RDFL8B ${LONG_TOKEN}`,
  archived: `RDFL8B Archív ${LONG_TOKEN}`,
}

/** The A10 surface: an open cycle carrying an order (renders `.display` + `.badge.ok`)
 *  and a completed one (renders the archive row's plain name and its `.mono` sum). */
const MATRIX = [
  cycleRow({
    id: 9801, name: NAMES.open, status: 'open',
    plan_note: '22. – 28. august — Objednávanie\n1. – 3. september — Delivery',
    hasOrder: true, orderTotal: 7.6, orderStatus: 'submitted', orderKilos: 0.25, orderItemCount: 1,
  }),
  cycleRow({
    id: 9802, name: NAMES.archived, status: 'completed', type: 'bakery',
    hasOrder: true, orderTotal: 13.09, orderStatus: 'submitted', orderItemCount: 3,
  }),
]

/** The same list with every free-text field weaponised.
 *
 * ⚠ PI-T3: `plan_note` and the cycle NAME no longer reach any friend screen (the card
 * that rendered them is retired), so the field that still carries the claim is
 * `expected_date` — admin FREE TEXT, rendered VERBATIM in the landing's status line
 * (§UC-PI-005 item 1). It is weaponised here for exactly that reason; the other two
 * stay so the fixture keeps its meaning when PI-T4/T5 render them again. */
const HOSTILE = [
  cycleRow({
    id: 9811, name: NAMES.hostile, status: 'open',
    plan_note: `Objednávky sem: ${LONG_URL}\n${LONG_TOKEN}`,
    expected_date: `${LONG_URL} ${LONG_TOKEN}`,
    hasOrder: true, orderTotal: 1234.56, orderStatus: 'submitted', orderKilos: 12.5, orderItemCount: 4,
  }),
  cycleRow({ id: 9812, name: NAMES.archived, status: 'completed', hasOrder: true, orderTotal: 44.15 }),
]

async function signIn(page, displayName = friend.name) {
  const stored = JSON.stringify({
    friendId: friend.id,
    friendName: displayName,
    friendUid: 'E2ERDFL8B',
    token: friend.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, stored)
}

async function stubs(page, { cycles = MATRIX, packeta = 'Z-BOX Hlavná 15, Bratislava', profileName = friend.name } = {}) {
  await page.route('**/api/friends/cycles*', (r) => r.fulfill({ json: cycles }))
  await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: -74.24, transactions: [] } }))
  await page.route('**/api/friends/*/profile', (r) => r.fulfill({
    json: { id: friend.id, name: profileName, uid: 'E2ERDFL8B', username: friend.username, hasCredentials: true, packeta_address: packeta },
  }))
  await page.route('**/api/subscriptions/friend/*', (r) => r.fulfill({ json: { types: ['coffee'] } }))
  await page.route('**/api/invitations/my-code*', (r) => r.fulfill({ json: { inviteCode: `RDFL8B-${LONG_TOKEN.slice(0, 40)}` } }))
  // Colleague counts are irrelevant here and one GET per open cycle is noise.
  await page.route('**/api/guest-links/cycle/*', (r) => r.fulfill({ status: 500, json: {} }))
}

/** `line-height: normal` is font-metric driven, and Google Fonts only downloads a
 *  family when something on the page uses it — so force the three families in
 *  before measuring anything, or the numbers are the fallback's. */
async function fontsReady(page) {
  await page.evaluate(async () => {
    const weights = [400, 500, 600, 700, 800]
    await Promise.all(['Figtree', 'Darker Grotesque', 'Courier Prime']
      .flatMap((f) => weights.map((w) => document.fonts.load(`${w} 16px "${f}"`))))
    await document.fonts.ready
  })
}

async function openPortal(page, opts = {}) {
  await signIn(page, opts.displayName)
  await stubs(page, opts)
  await page.goto('/')
  await expectLanding(page)
  await fontsReady(page)
}

// ---------------------------------------------------------------------------
// PI-T12 · 18 §UC-PI-019 item 13 — the LANDING fixtures
//
// ⚠ ONE REAL ROUND, and everything else stubbed around it. The locked landing's
// own-order card renders from the EMBEDDED `FriendOrder`'s loaded order (PI-T5's „no
// second loader"), and the closed/locked read-only grids render that round's real
// products — so a stub-only fixture (this file's idiom for the list) would paint
// neither. The round is built ONCE, on first use, and is LOCKED before anything reads
// it: a locked or completed round never becomes the „newest open" landing of a later
// spec file that reads the real list, which an open one would.
//
// The STATE comes from the stubbed `GET /friends/cycles` row that points at it, which
// is what lets one database round serve the closed, locked and no-order landings.
// ---------------------------------------------------------------------------

/** Admin free text, weaponised: what `plan_note` renders VERBATIM on the closed and
 *  locked landings (a PLANNED row's note with no usable `opens_at` — §UC-PI-002). */
const HOSTILE_NOTE = `Objednávky sem: ${LONG_URL}\n${LONG_TOKEN}`
/** The friend's own pickup note — rendered VERBATIM in the own-order pickup badge.
 *  132 chars: under `PATCH …/pickup`'s 200 bound, although the submit binds it unbounded. */
const HOSTILE_PICKUP = `Pri fontáne ${LONG_TOKEN}`
const ROUND_NAME = `RDFL8B Ponuka ${uniq} ${LONG_TOKEN}`

let realRoundMemo = null
async function realRound() {
  if (realRoundMemo) return realRoundMemo
  const made = await admin('/api/cycles', { method: 'post', data: { name: ROUND_NAME, type: 'coffee', status: 'open' } })
  expect(made.status(), 'round create').toBe(201)
  const cycle = await made.json()
  const product = await admin('/api/products', {
    method: 'post',
    // `roast_type` is what puts a `.badge` on the product card (`FriendOrder.vue`).
    data: { cycle_id: cycle.id, name: `RDFL8B Káva ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 8 },
  })
  expect(product.status(), 'product create').toBe(201)
  const productId = (await product.json()).id

  const auth = { Authorization: `Bearer ${friend.token}` }
  const put = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
    headers: auth, data: { items: [{ product_id: productId, variant: '250g', quantity: 2 }] }, timeout: TIMEOUT,
  })
  expect(put.status(), 'cart saved').toBe(200)
  const submit = await ctx.post(`/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, {
    headers: auth, data: { pickup_location_note: HOSTILE_PICKUP }, timeout: TIMEOUT,
  })
  expect(submit.status(), 'order submitted').toBe(200)
  expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status(), 'round locked')
    .toBe(200)

  realRoundMemo = { id: cycle.id }
  return realRoundMemo
}

/**
 * The PLANNED round — the source of the next-round text (`lib/cycle-stages.js
 * nextOpeningText()`). `next: 'note'` carries the hostile `plan_note` and no usable
 * `opens_at`, so the note renders VERBATIM (branch 2); `next: 'date'` carries an ISO
 * `opens_at`, so the state modal's card sets the date in 38px display type (branch 1).
 */
const plannedRow = (next = 'note') => cycleRow({
  id: 9831, name: `RDFL8B Plán ${uniq}`, status: 'planned', expected_date: `${LONG_URL} ${LONG_TOKEN}`,
  hasOrder: false, orderTotal: 0, orderStatus: null,
  ...(next === 'date' ? { opens_at: '2026-10-03', plan_note: null } : { opens_at: null, plan_note: HOSTILE_NOTE }),
})

/**
 * The three landing states, as `GET /friends/cycles` rows. ⚠ The real round's row
 * carries `opens_at`/`closes_at` for ONE reason: `timelineSteps()` renders a step's
 * `.when` line only when those dates are usable, and `.when` is the timeline's one
 * line-height-silent class (see the A10 test below).
 */
async function landingRows(state, next = 'note') {
  const { id } = await realRound()
  const base = {
    id, name: ROUND_NAME, expected_date: `${LONG_URL} ${LONG_TOKEN}`, plan_note: HOSTILE_NOTE,
    opens_at: '2026-09-01', closes_at: '2026-09-10', stage: 'ordered',
  }
  const planned = plannedRow(next)
  if (state === 'closed') return [cycleRow({ ...base, status: 'completed', hasOrder: true, orderTotal: 16 }), planned]
  if (state === 'locked') return [cycleRow({ ...base, status: 'locked', hasOrder: true, orderTotal: 16, orderStatus: 'submitted' }), planned]
  if (state === 'locked-no-order') return [cycleRow({ ...base, status: 'locked', hasOrder: false }), planned]
  throw new Error(`unknown landing state ${state}`)
}

async function openLanding(page, state, { next = 'note', path = '/', displayName, profileName } = {}) {
  await signIn(page, displayName)
  await stubs(page, { cycles: await landingRows(state, next), profileName: profileName ?? displayName ?? friend.name })
  const served = page.waitForResponse((r) => r.url().includes('/api/friends/cycles'), { timeout: TIMEOUT })
  await page.goto(path)
  await served
  await expectLanding(page)
  await fontsReady(page)
}

/** Assert every element `locator` matches computes `value` — and that there IS one. */
async function allCompute(locator, value, what) {
  const n = await locator.count()
  expect(n, `non-vacuity: ${what} is on screen`).toBeGreaterThan(0)
  for (let i = 0; i < n; i++) await expect(locator.nth(i), `${what} #${i}`).toHaveCSS('line-height', value)
}

// ===========================================================================
// (A) the line-height counter
// ===========================================================================

test.describe('A9/A10 — the preflight line-height counter is in force (02 §UC-DS-001)', () => {
  test('portal: every A10 class module 03 renders computes line-height:normal', async ({ page }) => {
    await openPortal(page)

    // theme classes covered by A10 (the RD-FL-8b additions among them)
    const ticker = page.locator('.ticker')
    await expect(ticker).toHaveCSS('line-height', 'normal')
    near((await ticker.boundingBox()).height, CANON.ticker, '.ticker height')

    // ⚠ PI-T7 · 18 §UC-PI-008/010 — `.neg.pill` IS NO LONGER RENDERED ANYWHERE, and
    // the two halves of what it measured part company here.
    //   · The STRUCTURE is gone: the pill was module 03's balance figure on the
    //     landing, and §UC-PI-008 takes the balance off the landing entirely (R2.3),
    //     while §UC-PI-010 paints the account card's figure as one `.display` at
    //     38px (`portal2.jsx:232`). `.neg.pill` has no caller in `frontend/src` at
    //     all now — a grep returns the theme declaration and two comments — so
    //     `near(…, CANON.negPill)` is unsatisfiable, not merely relocated. ~~`CANON`
    //     keeps the number as the record of what the canon said.~~ (PI-T12 retired
    //     the constant; the record is `friends-theme.css` §A10's table.)
    //   · The RULE — A10 covers `.neg`, so it must compute `line-height:normal` —
    //     survives and is re-measured below on the surviving `.neg`: the ledger row
    //     amount in „Zostatok a platby" (`FriendTransactionList.vue`). The landing's
    //     own A10 equivalents ~~stay PI-T12's, per item 13~~ are the (A2) describe below.
    await page.route('**/api/transactions/friend/*', (r) => r.fulfill({
      json: [{ id: 1, type: 'charge', amount: -74.24, created_at: '2026-03-04 12:00:00', cycle_name: 'A10', note: null }],
    }))
    await page.goto('/zostatok')
    await expectLanding(page)
    await fontsReady(page)
    const neg = page.locator('[data-testid="tx-amount"].neg')
    await expect(neg, 'non-vacuity: a `.neg` really is on screen').toHaveCount(1)
    await expect(neg).toHaveCSS('line-height', 'normal')

    // ⚠ PI-T3 · 18 §UC-PI-019 item 13 — THE CYCLE-CARD HALF OF THIS TEST IS RETIRED
    // WITH THE CARD (§UC-PI-005). It pinned A10 on `span.display` / `h3.display` /
    // `.badge.ok` / `[data-testid=cycle-date]` / `[data-testid=cycle-plan]`, five
    // elements that no longer exist on any screen. The A10 RULE is unchanged and is
    // still measured above on `.ticker` and `.neg`; item 13 assigns the LANDING
    // equivalents (`.banner.slim`, `.badge`, `own-order-card .display`, `.cs-tl .lbl`)
    // to PI-T12, once PI-T4/T5 have built the surfaces that carry them — DONE, the
    // (A2) describe below, where two of those four turned out not to be A10 sites.
    //
    // ⚠ The whole „portal: the PLAIN-TEXT call-site fixes survive" test went the same
    // way: both of its sites were the UC-FL-008 archive fold's (the toggle row and an
    // archived row's name/sum). The RULE it protected — „A9/A10 are class lists and a
    // plain-text site needs an inline `line-height:normal`" — is stated in
    // `friends-theme.css` §A10 and is re-asserted on the login screen's two sites in
    // the test below, so it is not left unwitnessed.
  })

  test('modern login: the dashed footnote card is the canon height, not the preflight one', async ({ page }) => {
    await page.route('**/friends/auth-mode', (r) => r.fulfill({ json: { authMode: 'modern' } }))
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Kto klope?' })).toBeVisible()
    await fontsReady(page)

    const dashed = page.locator('.card.dashed')
    await expect(dashed).toBeVisible()
    // Plain text, no theme class: only the inline declaration keeps it at the
    // canon. Inherited 1.5 measured it 12.75px taller — the single largest
    // fidelity drift module 03 had.
    await expect(dashed).toHaveCSS('line-height', 'normal')
    await expect(page.locator('.ticker')).toHaveCSS('line-height', 'normal')

    // The fourth plain-text site. Invisible today — the 24px `.cbox` sibling
    // sets this flex line's height either way — so nothing but this assertion
    // would notice the inline declaration being dropped, and the pattern is
    // meant to be copied by 04–06.
    const remember = page.locator('label', { hasText: 'Zapamätať si ma na tomto zariadení' })
    await expect(remember).toHaveCSS('line-height', 'normal')
  })

  test('the counter has ZERO specificity, so an explicit declaration always wins', async ({ page }) => {
    // The guarantee that makes a blanket class list safe. If someone "fixes" the
    // rule by dropping `:where()`, this fails and the cycle name silently
    // doubles in height.
    await openPortal(page)
    const parts = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        let rules
        try { rules = sheet.cssRules } catch { continue }
        for (const r of rules || []) {
          if (r.style?.lineHeight !== 'normal' || !r.selectorText?.includes('.ticker')) continue
          // split on TOP-LEVEL commas only — `:where(.app, .modal-layer)` has
          // one of its own, so a naive `.split(',')` shreds every selector.
          const out = []
          let depth = 0, cur = ''
          for (const ch of r.selectorText) {
            if (ch === '(') depth++
            else if (ch === ')') depth--
            if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += ch
          }
          out.push(cur.trim())
          return out
        }
      }
      return null
    })
    expect(parts, 'the A10 rule must be found in the shipped stylesheet').toBeTruthy()
    expect(parts.length, 'A10 covers a list of classes').toBeGreaterThan(10)
    const bare = parts.filter((p) => !p.startsWith(':where(.app, .modal-layer) '))
    expect(bare, 'every A10 selector must stay :where()-wrapped — dropping it raises the rule above the theme\'s own declarations and above every compound variant').toEqual([])
  })
})

// ===========================================================================
// (A2) PI-T12 · 18 §UC-PI-019 item 13 — the LANDING's A10 equivalents
// ===========================================================================
//
// PI-T3 retired this file's cycle-card half of (A) with the cards and left the landing
// equivalents to this row, once PI-T4/T5 had built the surfaces that carry them. Item 13
// names four: `.banner.slim`, `.badge`, `.display` inside `own-order-card`, and the
// timeline label. ⚠⚠ TWO OF THE FOUR ARE NOT A10 SITES AT ALL, and pinning them at
// `normal` as written would have pinned a DRIFT from the canon rather than the canon:
//
//   · own-order `.display` — the canon INLINES `lineHeight: 1` on both of them
//     (`portal2.jsx:350` „Vaša objednávka", `:356` the total). A10 only ever covers the
//     classes the canon leaves SILENT; an inline value is the canon speaking. Pinned at
//     that value (22px × 1).
//   · the timeline `.lbl` — `portal2.css:31` DECLARES `line-height:1.25` (and `:33`
//     `1` on the „now" step). `CycleTimeline.vue` ports both. Pinned at 18.75px / 20px.
//
// And the timeline's REAL A10 site is a class item 13 does not name: `.when`
// (`portal2.css:34`) declares no `line-height`, so the canon computes `normal` for it
// and the port inherited preflight's 1.5 — measured before the fix, see the test.
//
// `line-height: normal` is asserted EXACTLY (the mechanism, font-independent); the
// declared multipliers are asserted in px, which is exact too (the multiplier times the
// declared `font-size`, no font metric involved).

test.describe('PI-T12 · 18 §UC-PI-019 item 13 — the landing computes the canon line-heights', () => {
  test('OPEN: the status line and the debt banner are A10 `.banner.slim`s', async ({ page }) => {
    await openPortal(page, { cycles: HOSTILE })
    const status = page.getByTestId('landing-status')
    await expect(status).toHaveClass(/\bbanner\b.*\bslim\b/)
    await expect(status).toHaveCSS('line-height', 'normal')
    // The TEXT column inherits it — the claim is about the lines a friend reads, and an
    // inline declaration on the child would override the class without touching it.
    await expect(status.locator('> div')).toHaveCSS('line-height', 'normal')

    const debt = page.getByTestId('debt-banner')
    await expect(debt, 'non-vacuity: the stubbed −74.24 raises the debt banner').toBeVisible()
    await expect(debt).toHaveCSS('line-height', 'normal')
  })

  test('CLOSED: the state modal, the warn banner, the caption row and the catalogue badges', async ({ page }) => {
    await openLanding(page, 'closed', { next: 'date' })

    const modal = page.getByTestId('landing-state-modal')
    await expect(modal).toBeVisible()
    // The card's 38px date — NOT A10: the canon inlines `lineHeight: .9` (portal2.jsx:417).
    const date = modal.getByTestId('next-round-date')
    await expect(date, 'non-vacuity: the planned row\'s ISO `opens_at` takes the date branch').toBeVisible()
    await expect(date).toHaveCSS('font-size', '38px')
    await expect(date, 'the canon inlines lineHeight:.9 — portal2.jsx:417').toHaveCSS('line-height', '34.2px')
    await allCompute(modal.locator('.sub'), 'normal', 'the modal\'s `.sub` lines')
    await allCompute(modal.locator('.field-lbl'), 'normal', 'the modal\'s `.field-lbl`s')
    await allCompute(modal.getByTestId('timeline-captions').locator('.mono'), 'normal', 'the „Kde sme teraz" caption row')
    await page.getByRole('button', { name: 'Prezrieť ponuku' }).click()
    await expect(modal).toHaveCount(0)

    const banner = page.getByTestId('landing-closed-banner')
    await expect(banner).toHaveCSS('line-height', 'normal')
    await expect(banner.locator('> div')).toHaveCSS('line-height', 'normal')
    await allCompute(page.getByTestId(LANDING).locator('> div > span.field-lbl'), 'normal', 'the „Minulá ponuka" caption')
    await allCompute(page.getByTestId('product-card').locator('.badge'), 'normal', 'the read-only catalogue\'s `.badge`s')
  })

  test('LOCKED: the own-order card, „Kde je vaša káva" and the next-round banner', async ({ page }) => {
    await openLanding(page, 'locked')
    const card = page.getByTestId('own-order-card')
    await expect(card).toBeVisible()

    // `.badge` — Odoslaná, the pickup target, Nezaplatené, plus `CartLineList`'s purpose
    // group header (a `.badge` too): all A10. Named rather than only counted, so a lost
    // one is visible in the failure.
    await allCompute(card.locator('.badge'), 'normal', 'the own-order card\'s `.badge`s')
    for (const sel of ['.badge.ok', '[data-testid="own-order-pickup"]', '[data-testid="own-order-paid"]']) {
      await expect(card.locator(sel), `${sel} is one of them`).toHaveClass(/\bbadge\b/)
    }
    await expect(card.locator('.p2-tot .field-lbl')).toHaveCSS('line-height', 'normal')

    // ⚠ `.display` — the canon's INLINE `lineHeight: 1` (portal2.jsx:350/356), NOT A10.
    const displays = card.locator('.display')
    await expect(displays).toHaveCount(2)
    for (let i = 0; i < 2; i++) {
      await expect(displays.nth(i)).toHaveCSS('font-size', '22px')
      await expect(displays.nth(i), 'the canon inlines lineHeight:1 — portal2.jsx:350/356').toHaveCSS('line-height', '22px')
    }

    // The vertical timeline — module 17's component on module 18's screen.
    const tl = page.getByTestId('where-is-my-coffee')
    await expect(tl.locator('> .field-lbl')).toHaveCSS('line-height', 'normal')
    const lbl = tl.locator('.cs-tl .st:not(.now) .lbl')
    await expect(lbl, 'non-vacuity: five of the six steps are not „now"').toHaveCount(5)
    await allCompute(lbl, '18.75px', '`.cs-tl .lbl` — portal2.css:31 declares 1.25 on 15px')
    await expect(tl.locator('.cs-tl .st.now .lbl')).toHaveCSS('line-height', '20px')
    // ⚠ `.when` — the timeline's ONE line-height-silent text class (portal2.css:34),
    // hence `normal`. Three steps carry one (the fixture's `opens_at`/`closes_at`).
    const when = tl.locator('.cs-tl .when')
    await expect(when).toHaveCount(3)
    await allCompute(when, 'normal', '`.cs-tl .when`')

    const next = page.getByTestId('landing-next-round')
    await expect(next).toHaveCSS('line-height', 'normal')
    await expect(next.locator('> div')).toHaveCSS('line-height', 'normal')
    await allCompute(page.getByTestId('product-card').locator('.badge'), 'normal', 'the read-only grid\'s `.badge`s')
  })

  // ⚠ The two views below are not the LANDING, but their A10 pins were handed here by
  // name (learnings 10: PI-T6 „LEAVES BEHIND" 4, PI-T7 2) and they are module 18's own
  // surfaces, so the closeout owns them.
  test('„Moje objednávky": the round name is the canon\'s 20px × 1, the total is A10', async ({ page }) => {
    await openLanding(page, 'closed', { path: '/moje-objednavky' })
    const round = page.getByTestId('history-round')
    await expect(round, 'non-vacuity: the real round is `hasOrder`').toHaveCount(1)
    const name = round.locator('.display[data-user-copy]')
    await expect(name).toHaveCSS('font-size', '20px')
    await expect(name, 'the canon inlines lineHeight:1 — portal2.jsx:207').toHaveCSS('line-height', '20px')
    await expect(round.getByTestId('history-badge')).toHaveCSS('line-height', 'normal')
    // ⚠ The total's canon (`portal2.jsx:211`) sets `fontSize: 18` and NO line-height, so
    // `.display` is left to A10 — `normal`. PI-T6 shipped an inline `.9` (16.2px).
    const total = round.getByTestId('history-total')
    await expect(total).toHaveCSS('font-size', '18px')
    await expect(total, 'the canon declares no line-height here — A10 `.display`').toHaveCSS('line-height', 'normal')
  })

  test('„Zostatok a platby": the account figure is the canon\'s 38px × 1', async ({ page }) => {
    await openLanding(page, 'closed', { path: '/zostatok' })
    const figure = page.locator('.display').filter({ hasText: '74.24' })
    await expect(figure, 'non-vacuity: the stubbed −74.24 is on screen').toHaveCount(1)
    await expect(figure).toHaveCSS('font-size', '38px')
    await expect(figure, 'the canon inlines lineHeight:1 — portal2.jsx:232').toHaveCSS('line-height', '38px')
  })

  test('LOCKED with no own order: the state modal and the locked banner', async ({ page }) => {
    await openLanding(page, 'locked-no-order')
    const modal = page.getByTestId('landing-state-modal')
    await expect(modal.locator('.m-title')).toHaveText('Objednávky sú uzamknuté')
    await allCompute(modal.locator('.sub'), 'normal', 'the modal\'s `.sub` lines')
    await page.getByRole('button', { name: 'Prezrieť ponuku' }).click()

    const banner = page.getByTestId('landing-locked-banner')
    await expect(banner).toHaveCSS('line-height', 'normal')
    await expect(banner.locator('> div')).toHaveCSS('line-height', 'normal')
  })
})

// ===========================================================================
// (B) 320 px
// ===========================================================================

test.describe('320 px — zero horizontal document overflow with hostile free text (02 §UC-DS-005)', () => {
  test.use({ viewport: { width: 320, height: 800 } })

  /** The whole assertion: the DOCUMENT must not scroll sideways. A strip that
   *  clips its own over-wide content (`.ticker` is `overflow:hidden`) is fine —
   *  that is why this measures the document and not individual boxes. */
  const noOverflow = async (page, where) => {
    const m = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    expect(m.doc, `${where}: documentElement.scrollWidth ${m.doc} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client)
    expect(m.body, `${where}: body.scrollWidth ${m.body} > clientWidth ${m.client}`).toBeLessThanOrEqual(m.client)
  }

  /**
   * ⚠ THE SAME CLAIM FOR A SURFACE ON THE MODAL LAYER, which `noOverflow` CANNOT make.
   * `.modal-scrim` is `overflow-y:auto`, so its `overflow-x` computes to `auto` as well
   * and it ABSORBS any spill — the document never moves, and a document-level
   * measurement taken with a dialog up measures nothing (PI-T7 found exactly that on
   * the balance view's 320px test). So the layer is measured itself: the scrim must not
   * scroll sideways, and the box must neither overflow itself nor leave the viewport.
   * The drawer is the same shape (`.p2-drawer-scrim` / `.p2-drawer`).
   */
  //
  // ⚠⚠ AND NOT ONLY THE BOX — the first version of this helper measured the scrim and
  // the box, and it was VACUOUS for the drawer, which is the same trap one level in:
  // the drawer's row list is its own `overflow-y:auto` column, so it absorbed a 740px
  // spill (measured: 1016 > 271) while `.p2-drawer` itself reported a clean 271/271.
  // So every DESCENDANT is measured too: none may be a sideways scroller (`overflow-x`
  // `auto`/`scroll` with `scrollWidth > clientWidth`), and none may paint past the
  // box's right edge unless an ancestor inside the box deliberately clips it
  // (`hidden`/`clip` — the copy row's ellipsis is the legitimate case).
  const noLayerOverflow = async (page, where, { scrim = '.modal-scrim', box = '.modal' } = {}) => {
    const m = await page.evaluate(({ scrim, box }) => {
      const s = document.querySelector(`.modal-layer ${scrim}`)
      const b = s && s.querySelector(box)
      if (!s || !b) return null
      const right = b.getBoundingClientRect().right
      const clipped = (el) => {
        for (let p = el.parentElement; p && p !== b; p = p.parentElement) {
          if (/hidden|clip/.test(getComputedStyle(p).overflowX)) return true
        }
        return false
      }
      const scrollers = []
      const outside = []
      for (const el of b.querySelectorAll('*')) {
        const ox = getComputedStyle(el).overflowX
        if (/auto|scroll/.test(ox) && el.scrollWidth > el.clientWidth + 1) {
          scrollers.push(`${el.tagName.toLowerCase()}.${el.className} ${el.scrollWidth} > ${el.clientWidth}`)
        }
        const r = el.getBoundingClientRect()
        if (r.width && r.right > right + 1 && !clipped(el)) outside.push(`${el.tagName.toLowerCase()}.${el.className} right ${Math.round(r.right)}`)
      }
      return {
        scrimScroll: s.scrollWidth, scrimClient: s.clientWidth,
        boxScroll: b.scrollWidth, boxClient: b.clientWidth,
        right, vw: document.documentElement.clientWidth,
        scrollers, outside, measured: b.querySelectorAll('*').length,
      }
    }, { scrim, box })
    expect(m, `${where}: the layer is up`).toBeTruthy()
    expect(m.measured, `${where}: non-vacuity — the box has content to measure`).toBeGreaterThan(5)
    expect(m.scrimScroll, `${where}: ${scrim} scrolls sideways (${m.scrimScroll} > ${m.scrimClient})`).toBeLessThanOrEqual(m.scrimClient)
    expect(m.boxScroll, `${where}: ${box} overflows itself (${m.boxScroll} > ${m.boxClient})`).toBeLessThanOrEqual(m.boxClient)
    expect(m.right, `${where}: ${box} leaves the viewport (right ${m.right} > ${m.vw})`).toBeLessThanOrEqual(m.vw)
    expect(m.scrollers, `${where}: an element inside ${box} scrolls sideways`).toEqual([])
    expect(m.outside, `${where}: an element paints past ${box}'s right edge`).toEqual([])
  }

  test('modern login', async ({ page }) => {
    await page.route('**/friends/auth-mode', (r) => r.fulfill({ json: { authMode: 'modern' } }))
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Kto klope?' })).toBeVisible()
    await noOverflow(page, 'modern login')
  })

  // ⚠ PI-T12 · 18 §UC-PI-019 item 13 — „320 px hostile text in `plan_note` /
  // `expected_date` / pickup note / cycle name on ALL THREE states". The OPEN state is
  // the next test (its one rendered field of the four is `expected_date`). Every
  // fixture below weaponises all four; each test asserts the ones ITS state renders —
  // with a non-vacuity check that the hostile text really reached that element — because
  // a field a state does not render cannot scroll it, and pinning it would be vacuous.

  test('CLOSED landing — hostile `plan_note` (modal card, banner), round name (caption, drawer)', async ({ page }) => {
    // The friend's own NAME too: the drawer header is the one place it renders
    // (§UC-PI-003), and it is person-typed free text like the round name.
    await openLanding(page, 'closed', { displayName: `Meno ${LONG_TOKEN}` })
    const modal = page.getByTestId('landing-state-modal')
    const card = modal.getByTestId('next-round-text')
    await expect(card).toContainText(LONG_TOKEN)
    await expect(card).toHaveCSS('overflow-wrap', 'anywhere')
    await noLayerOverflow(page, 'closed state modal')
    await modal.getByRole('button', { name: 'Prezrieť ponuku' }).click()
    await expect(modal).toHaveCount(0)

    const banner = page.getByTestId('landing-closed-banner')
    await expect(banner).toContainText(LONG_TOKEN)
    await expect(banner.locator('> div')).toHaveCSS('overflow-wrap', 'anywhere')
    const caption = page.getByTestId(LANDING).locator('> div > span.field-lbl')
    await expect(caption).toContainText(ROUND_NAME)
    await expect(caption).toHaveCSS('overflow-wrap', 'anywhere')
    await noOverflow(page, 'closed landing')

    // The cycle name's OTHER render: the drawer's „Moje objednávky" sub-line
    // („… · naposledy {name}"), on the modal layer — so measured as a layer.
    await page.locator('.appbar [aria-label="Menu"]').click()
    const menu = page.getByRole('dialog', { name: 'Menu' })
    await expect(menu.locator('[data-menu-item="history"]'), 'non-vacuity: the round name is in the sub-line').toContainText(LONG_TOKEN)
    await expect(page.getByTestId('drawer-friend-name'), 'non-vacuity: the hostile friend name').toContainText(LONG_TOKEN)
    await noLayerOverflow(page, 'drawer', { scrim: '.p2-drawer-scrim', box: '.p2-drawer' })
  })

  // ⚠ THE DEFECT THE CLOSED TEST ABOVE FOUND (PI-T12), pinned in both directions. The
  // state modal's footer („Ako to funguje" + „Prezrieť ponuku", both `nowrap` + `flex:1`)
  // needs ~290px of min-content and a 320px viewport leaves 240, so it painted past the
  // box and the scrim scrolled sideways (330 > 320) — with NO hostile text at all. The
  // fix wraps the row; this pins that it still is the CANON'S ONE ROW at 378px, so the
  // repair cannot drift into a permanent column (the Google prompt's shape) unnoticed.
  test('the state modal footer: the canon\'s one row at 378px, two rows inside the box at 320px', async ({ page }) => {
    await openLanding(page, 'closed')
    const buttons = () => page.getByTestId('landing-state-modal').locator('.m-foot .btn')
    await expect(buttons()).toHaveText(['Ako to funguje', 'Prezrieť ponuku'])
    const boxes = async () => Promise.all([0, 1].map((i) => buttons().nth(i).boundingBox()))

    const [a320, b320] = await boxes()
    expect(b320.y, '320px: the row wraps').toBeGreaterThan(a320.y)
    await noLayerOverflow(page, 'state modal footer at 320px')

    await page.setViewportSize({ width: 378, height: 800 })
    await expect.poll(async () => { const [a, b] = await boxes(); return Math.round(b.y - a.y) }, { message: '378px: ONE row' }).toBe(0)
    const [a378, b378] = await boxes()
    near(a378.width, b378.width, '378px: the canon\'s two EQUAL buttons')
    await noLayerOverflow(page, 'state modal footer at 378px')
  })

  test('LOCKED landing — hostile pickup note (own-order badge), `plan_note` (next-round banner), round name', async ({ page }) => {
    await openLanding(page, 'locked')
    const pickup = page.getByTestId('own-order-pickup')
    await expect(pickup).toContainText(LONG_TOKEN)
    await expect(pickup).toHaveCSS('overflow-wrap', 'anywhere')
    const next = page.getByTestId('landing-next-round')
    await expect(next).toContainText(LONG_TOKEN)
    await expect(next.locator('> div')).toHaveCSS('overflow-wrap', 'anywhere')
    const caption = page.getByTestId(LANDING).locator('> div > span.field-lbl')
    await expect(caption).toContainText(ROUND_NAME)
    await expect(caption).toHaveCSS('overflow-wrap', 'anywhere')
    await noOverflow(page, 'locked landing')
  })

  test('LOCKED with no own order — hostile `plan_note` in the state modal and the locked banner', async ({ page }) => {
    await openLanding(page, 'locked-no-order')
    const modal = page.getByTestId('landing-state-modal')
    await expect(modal.getByTestId('next-round-text')).toContainText(LONG_TOKEN)
    await noLayerOverflow(page, 'locked state modal')
    await modal.getByRole('button', { name: 'Prezrieť ponuku' }).click()
    await expect(modal).toHaveCount(0)

    const banner = page.getByTestId('landing-locked-banner')
    await expect(banner).toContainText(LONG_TOKEN)
    await expect(banner.locator('> div')).toHaveCSS('overflow-wrap', 'anywhere')
    await expect(page.getByTestId(LANDING).locator('> div > span.field-lbl')).toContainText(ROUND_NAME)
    await noOverflow(page, 'locked landing, no own order')
  })

  test('portal, with a 120-char display name and a hostile `expected_date`', async ({ page }) => {
    // ⚠ PI-T3 · 18 §UC-PI-019 item 13: the CARD assertions this test carried
    // (`cycle-plan` / `h3.display` `overflow-wrap`, and the archive fold) are retired
    // with the structures. But the CLAIM they protected — free ADMIN text must not
    // scroll the document sideways; RD-FL-4 measured 531px against a 320px viewport on
    // a pasted Google Sheets URL — is NOT retired, because the landing renders one such
    // field VERBATIM: `expected_date`, in the status line (§UC-PI-005 item 1, „admin
    // free text, rendered verbatim"). So the fixture weaponises that field and the
    // claim is asserted on the element that carries it. (The A10 line-height half is
    // ~~still PI-T12's~~ the (A2) describe; the closed and locked states' hostile-text
    // passes are the PI-T12 tests above this one.)
    await openPortal(page, { cycles: HOSTILE, displayName: `Meno ${LONG_TOKEN}` })

    const line = page.getByTestId('landing-status')
    // Non-vacuity: the hostile text really reached the screen.
    await expect(line).toContainText(LONG_TOKEN)
    await expect(line.locator('div').first(), 'the status line must break an unbreakable token')
      .toHaveCSS('overflow-wrap', 'anywhere')

    await noOverflow(page, 'portal')
  })

  test('the appbar ellipsizes a long display name rather than widening the bar', async ({ page }) => {
    await openPortal(page, { cycles: HOSTILE, displayName: `Meno ${LONG_TOKEN}` })
    const t = page.locator('.appbar .titles .t')
    await expect(t).toHaveCSS('text-overflow', 'ellipsis')
    await expect(t).toHaveCSS('overflow-x', 'hidden')
    const box = await t.boundingBox()
    expect(box.width, 'the name block must stay inside the viewport').toBeLessThanOrEqual(320)
  })

  test('profile modal — long username and Packeta address', async ({ page }) => {
    await openPortal(page, { cycles: HOSTILE, packeta: `Z-BOX ${LONG_URL}` })
    await openProfile(page)
    await expect(page.getByRole('dialog')).toBeVisible()
    await noOverflow(page, 'profile modal')
    // ⚠ PI-T12: the document check above cannot see a dialog (the scrim absorbs the
    // spill — see `noLayerOverflow`), so the layer is measured as well.
    await noLayerOverflow(page, 'profile modal')
    await page.getByRole('button', { name: 'Zmeniť heslo' }).click()
    await expect(page.getByLabel('Aktuálne heslo')).toBeVisible()
    await noOverflow(page, 'profile modal + password fold')
    await noLayerOverflow(page, 'profile modal + password fold')
  })

  // ⚠ PI-T3 · 18 §UC-PI-016 — the „subscription modal" 320px test is RETIRED: the
  // modal is gone (the column and both routes stay). No other dialog lost its pass;
  // profile and invite are measured above and below.

  test('invite modal — the copy row must ellipsize, never widen the page', async ({ page }) => {
    await openPortal(page, { cycles: HOSTILE })
    await page.locator('.appbar .chip.acc').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.locator('.copyrow .val')).toBeVisible()
    await expect(page.locator('.copyrow .val')).toHaveCSS('text-overflow', 'ellipsis')
    await noOverflow(page, 'invite modal')
    await noLayerOverflow(page, 'invite modal') // PI-T12 — see the profile modal test
  })

  test('portal load failure — the error banner wraps its (unbounded) server message', async ({ page }) => {
    await signIn(page)
    await stubs(page)
    // The banner's own writer is the initial load; a long message must not push
    // the page sideways.
    await page.route('**/api/friends/cycles*', (r) => r.fulfill({
      status: 500, json: { error: `Zlyhalo načítanie: ${LONG_URL}` },
    }))
    await page.goto('/')
    await page.waitForTimeout(1500)
    await noOverflow(page, 'portal load failure')
  })
})
