import { test, expect, request as playwrightRequest } from '@playwright/test'
// PI-T1 · 18 §UC-PI-019 item 1 — the ONE home of the „portal is ready“ gate.
// It replaces this file's `getByRole('heading', { name: 'Objednávkové cykly' })`
// waits: that heading is a STRUCTURE module 18 retires (§UC-PI-005), so a gate
// tied to its copy could not survive the screen. Same claim, one home.
import { expectLanding, openProfile } from '../helpers/portal.js'
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
const CANON = { ticker: 34, negPill: 28 }

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

async function stubs(page, { cycles = MATRIX, packeta = 'Z-BOX Hlavná 15, Bratislava' } = {}) {
  await page.route('**/api/friends/cycles*', (r) => r.fulfill({ json: cycles }))
  await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: -74.24, transactions: [] } }))
  await page.route('**/api/friends/*/profile', (r) => r.fulfill({
    json: { id: friend.id, name: friend.name, uid: 'E2ERDFL8B', username: friend.username, hasCredentials: true, packeta_address: packeta },
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

    const pill = page.locator('.neg.pill')
    await expect(pill).toHaveCSS('line-height', 'normal')
    near((await pill.boundingBox()).height, CANON.negPill, '.neg.pill height')

    // ⚠ PI-T3 · 18 §UC-PI-019 item 13 — THE CYCLE-CARD HALF OF THIS TEST IS RETIRED
    // WITH THE CARD (§UC-PI-005). It pinned A10 on `span.display` / `h3.display` /
    // `.badge.ok` / `[data-testid=cycle-date]` / `[data-testid=cycle-plan]`, five
    // elements that no longer exist on any screen. The A10 RULE is unchanged and is
    // still measured above on `.ticker` and `.neg.pill`; item 13 assigns the LANDING
    // equivalents (`.banner.slim`, `.badge`, `own-order-card .display`, `.cs-tl .lbl`)
    // to PI-T12, once PI-T4/T5 have built the surfaces that carry them.
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

  test('modern login', async ({ page }) => {
    await page.route('**/friends/auth-mode', (r) => r.fulfill({ json: { authMode: 'modern' } }))
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Kto klope?' })).toBeVisible()
    await noOverflow(page, 'modern login')
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
    // still PI-T12's, once PI-T4/T5 build the surfaces it needs.)
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
    await page.getByRole('button', { name: 'Zmeniť heslo' }).click()
    await expect(page.getByLabel('Aktuálne heslo')).toBeVisible()
    await noOverflow(page, 'profile modal + password fold')
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
