import { test, expect, request as playwrightRequest } from '@playwright/test'
// PI-T1 · 18 §UC-PI-019 item 1 — the ONE home of the „portal is ready“ gate.
// It replaces this file's `getByRole('heading', { name: 'Objednávkové cykly' })`
// waits: that heading is a STRUCTURE module 18 retires (§UC-PI-005), so a gate
// tied to its copy could not survive the screen. Same claim, one home.
import { LANDING, ackExplainer, expectLanding, logout, menuGo, openMenu, openProfile } from '../helpers/portal.js'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

// RD-FL-7 — the session-boundary regression net.
//
// ⚠ WHY THIS FILE EXISTS, in one paragraph: `switchUser()` has leaked session
// state in SIX consecutive rows — `error`/`voucherResolved`/`subscriptions`
// (RD-FL-3), `showArchive` (RD-FL-4), `guestCounts` (RD-FL-5), the
// credential-setup block holding a PLAINTEXT password that auto-rendered in the
// next person's dialog, and `showLoginPassword` (RD-FL-6). The sixth was found
// by a reviewer sweeping the component, not by reviewing the list of refs the
// previous rows had assembled. List-review has therefore demonstrably stopped
// working, and every row still adds refs.
//
// So this spec enumerates the SURFACE, not the refs. It walks everything a
// friend can open — ~~every disclosure, every modal reachable from the appbar and
// the cycle cards~~ **since PI-T12 (18 §UC-PI-019 item 14): every item of the
// hamburger DRAWER** (history with a round expanded, „Zostatok a platby" with its
// Platba modal, „Ako to funguje", Profil with its password fold, „Pozvať priateľa",
// „Zdieľať s kolegami" when the landing's round is open) **plus the first-login
// explainer GATE and its „Už mi to neukazovať" checkbox** — types a unique
// `SENTINEL-<n>` into every field, ticks every control, logs out, logs a DIFFERENT
// friend in, and walks the same surface again asserting four invariants that name
// no ref at all:
//
//   1. `page.content()` contains no `SENTINEL-`;
//   2. every visible password-ish field still renders `type="password"`;
//   3. every visible `input`/`textarea` is empty or re-derived from the SECOND
//      friend's own profile;
//   4. every visible `[aria-pressed]` toggle reads `"false"` — B pressed nothing,
//      so nothing on B's screen may be engaged.
//
// A row that adds a modal is covered the moment the modal is reachable from ~~the
// appbar or a cycle card~~ a DRAWER item (the cycle cards are retired, 18
// §UC-PI-005) — ⚠ with one edit here after all: the walk names the drawer's rows,
// because a view has no generic „open everything" control. So the walk READS the
// drawer's `[data-menu-item]` keys at its drawer stop and reds on any key it does not
// visit (`WALKED_ROWS`) — a new row cannot join the drawer without joining this walk.
//
// ⚠ SCOPE, STATED HONESTLY — this net is narrower than the paragraph above
// suggests, and nobody should read a green run as "switchUser() is clean".
// Of the SIX leaks that motivate it, it would have caught **two**: the
// credential-setup block (invariant 3, and the setup password field also
// invariant 2 once the placeholder was added to the predicate) and
// `showLoginPassword` (invariants 2 and 4). It would have caught NONE of
// `error`, `voucherResolved`, `showArchive` or `guestCounts`, because those
// render as text/visibility rather than as a field value or an input type — and
// it catches none of this row's own new clears (`showSubscriptionModal`,
// `subCoffee`/`subBakery`, `subSaving`, `showInviteModal`, `inviteError`,
// `inviteLoading`, `inviteSeq`, `setupSaving`, `changePasswordSaving`,
// `profileSaving`) for the same reason. That is a deliberate scope choice: the
// three invariants that ARE here are cheap, ref-free and total over the fields,
// whereas "no stale rendered text anywhere" has no non-arbitrary formulation.
//
// ⚠ In particular the `show*Modal` clears are defended BY CONSTRUCTION and this
// file cannot falsify them: while a modal is open the scrim covers the appbar,
// so the logout control is unclickable and the walk can never reach the boundary
// with a dialog raised. Their justification is the argument in `switchUser()`,
// not a green run here. The one class the net does bite that construction
// misses is the in-flight saving flags — see the dedicated `setupSaving` test at
// the bottom, which reaches the boundary through Esc rather than through logout.
//
// KNOWN AND ACCEPTED LIMIT: it only covers state that RENDERS. A ref that
// survives a logout without ever reaching the DOM is invisible to this file —
// and is also not the hazard. The hazard is the next person SEEING or SUBMITTING
// the previous person's data.
//
// ⚠ NO RELOAD ANYWHERE. Both logins happen in ONE component instance; a
// `page.goto()` between them remounts `FriendPortal.vue`, re-initialises every
// ref regardless of `switchUser()`, and makes the whole file vacuous. That is
// also why the login screen has to be the MODERN one (stubbed per page, RD-FL-2's
// idiom) or the transition dropdown — both re-authenticate in place.
//
// HERMETIC, per `portal-profile-modal.spec.js`: every friend is provisioned over
// the admin API inside the test, nothing global is mutated, the shared seed stays
// legacy.

const TIMEOUT = 20_000
// ⚠ DISTINCT per friend, deliberately. With one shared constant the
// `expect(values).not.toContain(a.password)` sweep below cannot tell A's secret
// from B's own — it is a no-op today (the login form is `v-if`, so B's filled
// field is gone by the time the walk snapshots) and a false-failure trap the
// moment that becomes `v-show`: B's OWN password in B's own field would trip an
// assertion about A's. Two values, and the sweep means what it says.
const PASSWORD_A = 'ownPassA12'
const PASSWORD_B = 'ownPassB34'

let ctx = null
let adminToken = ''

let sentinelSeq = 0
const nextSentinel = () => `SENTINEL-${++sentinelSeq}`

function uniq() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
}

// FUP-T27 — ONE home for the admin request path: it re-authenticates ONCE on a
// 401 instead of trusting a token the next `POST /api/admin/login` anywhere in the
// suite silently rotates out. See `helpers/admin.js`.
const admin = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
  timeout: TIMEOUT,
})

/**
 * A friend with a username and a known personal password, no forced-change flag.
 * `reset-password` always raises `must_change_password`, so it is cleared the way
 * a real friend clears it: one login + one change.
 */
// ⚠ 18 §UC-PI-015 (PI-T10) — see the note inside the two builders below. UNIQUE per
// friend on purpose: the phone is now a FIELD VALUE the boundary sweep sees, so a
// shared number would make „A's phone on B's screen" indistinguishable from „B's own".
let boundaryPhoneSeq = 0
const nextBoundaryPhone = () => `0900 12 3${String(++boundaryPhoneSeq).padStart(3, '0')}`

async function makeFriend(label, password, { ack = true } = {}) {
  expect(password, 'each friend needs their OWN password — see PASSWORD_A/B').toBeTruthy()
  const u = uniq()
  const phone = nextBoundaryPhone()
  const name = `RDFL7 ${label} ${u}`
  const username = `rdfl7${label}${u}`.toLowerCase().slice(0, 30)

  // ⚠ 18 §UC-PI-015 (PI-T10) — the phone, for the same reason as the `ackExplainer`
  // call below: these friends log in THROUGH THE CARD, and the profile modal now
  // AUTO-OPENS on a login for a friend with no stored phone. The surface walk here
  // opens and counts dialogs of its own, so an uninvited one would be measured as
  // leaked state. („Mobil *" is also required, so „Uložiť" would be disabled.)
  const created = await admin('/api/friends', { method: 'post', data: { name, phone } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const first = (await auth.json()).token

  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${first}` },
    data: { currentPassword: 'initPass1', newPassword: password },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'clear forced change').toBe(200)
  const token = (await changed.json()).token

  // ⚠ 18 §UC-PI-013 (PI-T9): a friend created here has never acknowledged „Ako to
  // funguje", so a LOGIN THROUGH THE CARD would land on `/ako-to-funguje` — where the
  // hamburger is a back chevron, so every drawer helper below times out. One round
  // trip through the real route; see `helpers/portal.js ackExplainer`.
  // ⚠ `ack: false` (PI-T12) is the modern-login test's choice, and it is deliberate:
  // the GATE is part of the surface this file walks (18 §UC-PI-019 item 14, „the
  // explainer incl. the checkbox"), and the checkbox renders ONLY on the gate — the
  // drawer's „Ako to funguje" is the same view without it. So that test's friends are
  // left unacknowledged and `walkAuthenticated({ gate: true })` walks it first.
  if (ack) await ackExplainer(ctx, { id: row.id, token })

  const profile = await ctx.get(`/api/friends/${row.id}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT,
  })
  expect(profile.status(), 'friend profile').toBe(200)
  const full = await profile.json()

  // The invite code is an IDENTITY, not decoration — registrations through it
  // are credited to its owner — and the invite modal is the one place a friend
  // sees theirs. Captured here so the sweep below can prove A's never reaches
  // B's screen (RD-FL-7 added `inviteError`/`inviteSeq` around exactly this).
  const code = await ctx.get(`/api/invitations/my-code?friendId=${row.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT,
  })
  expect(code.status(), 'invite code').toBe(200)
  const inviteCode = (await code.json()).inviteCode
  expect(inviteCode, 'invite code is what the modal renders').toBeTruthy()

  return { id: row.id, name, username, uid: full.uid, password, phone, packeta: full.packeta_address || '', inviteCode }
}

/** A friend with NO personal credentials — transition mode auto-raises the setup dialog for them. */
async function makePlainFriend(label) {
  const name = `RDFL7 ${label} ${uniq()}`
  const phone = nextBoundaryPhone()
  // ⚠ 18 §UC-PI-015 (PI-T10) — the phone, for the same reason as the `ackExplainer`
  // call below: these friends log in THROUGH THE CARD, and the profile modal now
  // AUTO-OPENS on a login for a friend with no stored phone. The surface walk here
  // opens and counts dialogs of its own, so an uninvited one would be measured as
  // leaked state. („Mobil *" is also required, so „Uložiť" would be disabled.)
  const created = await admin('/api/friends', { method: 'post', data: { name, phone } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  // ⚠ 18 §UC-PI-013 (PI-T9), and this friend needed the LONG way round: they have no
  // credentials at all, so there is no personal login to mint a session with. The
  // LEGACY shared-password branch of `POST /friends/auth` mints a per-friend session
  // for exactly this case (`friends.js`, the `requireHost` comment), which is the one
  // token that can acknowledge the explainer on their behalf. Without it the
  // transition-mode test below logs in through the card, lands on `/ako-to-funguje`,
  // and never reaches the auto-raised credential-setup dialog it is about.
  const auth = await ctx.post('/api/friends/auth', {
    data: { password: FRIENDS_PASSWORD, friendId: row.id },
    timeout: TIMEOUT,
  })
  expect(auth.status(), 'legacy shared-password session for a credential-less friend').toBe(200)
  await ackExplainer(ctx, { id: row.id, token: (await auth.json()).token })

  return { id: row.id, name, uid: row.uid || '', phone }
}

/**
 * ⚠ Kill the UC-FL-007 colleague-count storm (RD-FL-6's flake).
 *
 * The cycle list fires one fire-and-forget `GET /api/guest-links/cycle/:id` per
 * OPEN cycle, and a full-suite database accumulates well over a hundred. A test
 * that logs in TWICE in one page queues a few hundred XHRs behind the browser's
 * 6-connection limit and the SECOND login's own calls starve behind them — it
 * passes in isolation and fails in a full run. The counts are decoration whose
 * fetch already swallows errors, so dropping them changes nothing asserted here.
 */
async function muteGuestCounts(page) {
  await page.route('**/api/guest-links/cycle/*', (route) => route.abort())
}

/**
 * ⚠ PI-T12 — the data two drawer stops need, and nothing global is written for it.
 *
 * A fresh friend has no rounds and no debt, so „Moje objednávky" would be its EMPTY
 * state and „Zostatok a platby" would offer no „Zaplatiť" — two surfaces with nothing
 * to expand, fill or leak. Both are STUBBED per page rather than created, keeping this
 * file's „nothing global is mutated" rule (a real round would be a cycle every later
 * spec file sees):
 *   · `GET /friends/cycles` is the REAL list plus ONE completed `hasOrder` round
 *     (`route.fetch()`), so the landing keeps whatever state the database is in and the
 *     history view gains exactly one row. A completed row never outranks an open one
 *     in `resolveLanding()`.
 *   · that round's line fetch answers PER FRIEND — the line names the friend id it was
 *     asked for, `#<id>#` — so a lines cache that survived the logout would paint A's
 *     line on B's screen, and the secret sweep names A's.
 *   · a debt balance with a `payment` block, so the Platba modal can open — ALSO per
 *     friend (PI-T12 review): amount, reference and variable symbol all derive from
 *     the id asked for, so a balance or payment block that survived the logout paints
 *     A's figures on B's landing banner, drawer badge, account card and Platba modal,
 *     and the secret sweep names all three.
 */
const HISTORY_ROUND_ID = 990_071
const historyLine = (friendId) => `History line for #${friendId}#`
const balanceFor = (friendId) => {
  const id = Number(friendId)
  return {
    amount: 500 + id + 0.37,
    reference: `RDFL7 / zostatok #${id}#`,
    variable_symbol: `8${String(id).padStart(6, '0')}`,
  }
}
/** What of friend A's money block must never render on B's screen. */
const balanceSecrets = (friendId) => {
  const b = balanceFor(friendId)
  return [b.amount.toFixed(2), b.reference, b.variable_symbol]
}

async function stubWalkData(page) {
  await page.route('**/api/friends/cycles*', async (route) => {
    const res = await route.fetch()
    const list = await res.json()
    await route.fulfill({
      response: res,
      json: [...(Array.isArray(list) ? list : []), {
        id: HISTORY_ROUND_ID, name: 'RDFL7 History round', status: 'completed',
        created_at: '2026-01-01 10:00:00', type: 'coffee', expected_date: null, plan_note: null,
        opens_at: null, closes_at: null, stage: null, parcel_enabled: 0, parcel_fee: 0,
        hasOrder: true, orderTotal: 16, orderStatus: 'submitted', orderKilos: 0.5, orderItemCount: 1,
        orderPickupName: null, orderPacketa: false, orderPaid: true, orderHandedOver: true,
      }],
    })
  })
  await page.route(`**/api/orders/cycle/${HISTORY_ROUND_ID}/friend/*`, (route) => {
    const friendId = route.request().url().match(/\/friend\/(\d+)/)[1]
    return route.fulfill({
      json: {
        order: { id: 1, status: 'submitted', total: 16, delivery_fee: 0 },
        items: [{ id: 1, product_name: historyLine(friendId), purpose: 'Espresso', variant: '250g', quantity: 2, price: 8 }],
      },
    })
  })
  await page.route('**/api/friends/*/balance', (route) => {
    const b = balanceFor(route.request().url().match(/\/friends\/(\d+)\/balance/)[1])
    return route.fulfill({
      json: {
        balance: -b.amount,
        transactions: [],
        payment: {
          amount: b.amount, reference: b.reference, iban: 'SK3112000000198742637541',
          revolut_username: 'gorifitest', variable_symbol: b.variable_symbol, creditor_name: 'Gorifi',
        },
      },
    })
  })
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => { await ctx?.dispose() })

// ---------------------------------------------------------------------------
// The surface walk
// ---------------------------------------------------------------------------

/**
 * Everything the three invariants are checked against, captured from the LIVE
 * DOM rather than from a locator list — a field that no assertion knows about is
 * still in here.
 */
async function snapshot(page, label) {
  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        id: el.id || '',
        name: el.getAttribute('name') || '',
        type: (el.getAttribute('type') || '').toLowerCase(),
        autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
        placeholder: el.getAttribute('placeholder') || '',
        value: el.value,
        visible: !!(r.width || r.height) && getComputedStyle(el).visibility !== 'hidden',
      }
    })
  )
  // Invariant 4's material. Captured as a class (`[aria-pressed]`), not by ref
  // name, so any FUTURE reveal/press toggle is covered the day it is written —
  // and, unlike invariants 2 and 3, this one does not depend on the field
  // carrying useful `autocomplete`/`id`/`name`/`placeholder` metadata, which the
  // credential-setup dialog's own password inputs mostly do not.
  const toggles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-pressed]')).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        name: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 40) || '(unnamed toggle)',
        pressed: (el.getAttribute('aria-pressed') || '').toLowerCase(),
        visible: !!(r.width || r.height) && getComputedStyle(el).visibility !== 'hidden',
      }
    })
  )
  return { label, html: await page.content(), fields, toggles }
}

/** Type/tick into everything inside `scope`. Buttons are never pressed — nothing is saved. */
async function fillEverything(scope) {
  const fields = scope.locator('input:visible, textarea:visible')
  const n = await fields.count()
  for (let i = 0; i < n; i++) {
    const f = fields.nth(i)
    const type = ((await f.getAttribute('type')) || '').toLowerCase()
    if (type === 'checkbox' || type === 'radio') { await f.click(); continue }
    if (await f.isEditable()) await f.fill(nextSentinel())
  }
  // The house checkbox is a `span[role=checkbox]` (UC-DS-009), invisible to the
  // `input` sweep above, and the reveal toggles are `span[aria-pressed]`.
  const boxes = scope.locator('[role=checkbox]:visible')
  for (let i = 0, c = await boxes.count(); i < c; i++) await boxes.nth(i).click()
  const reveals = scope.locator('[aria-pressed]:visible')
  for (let i = 0, c = await reveals.count(); i < c; i++) await reveals.nth(i).click()
}

/**
 * Walk the whole authenticated surface — the DRAWER, item by item (18 §UC-PI-019
 * item 14), plus the first-login gate when `gate` is set.
 *
 * `fill: true`  — seed it (friend A).
 * `fill: false` — re-open the same things and snapshot each (friend B).
 * `self`        — the friend walking, for the per-friend non-vacuity checks.
 *
 * Deliberately NOT a list of known refs: it enumerates what a friend can OPEN.
 */
/** The drawer rows the walk visits, by `data-menu-item` key. `shop` is the landing stop. */
const WALKED_ROWS = ['shop', 'history', 'balance', 'share', 'invite', 'explainer', 'profile']

async function walkAuthenticated(page, { fill, snaps = [], label = '', gate = false, self = null } = {}) {
  const record = async (tag) => { if (!fill) snaps.push(await snapshot(page, `${label}:${tag}`)) }
  const home = new RegExp('/$')

  // ── 0. THE FIRST-LOGIN GATE (18 §UC-PI-013) — the one place „Už mi to neukazovať"
  // renders. PRE-TICKED is its default (§UC-PI-012 item 8), so friend A UNTICKS it
  // and friend B must meet it ticked again: an unticked box carried across the
  // boundary would silently skip B's acknowledgement write. ⚠ That is a state
  // invariant 4 cannot see (`aria-checked`, not `aria-pressed`), hence named here.
  if (gate) {
    await expect(page).toHaveURL(/\/ako-to-funguje$/)
    const box = page.getByRole('checkbox', { name: 'Už mi to neukazovať' })
    await expect(box, `${label || 'A'}: the gate's checkbox arrives pre-ticked`).toHaveAttribute('aria-checked', 'true')
    if (fill) {
      await fillEverything(page.getByTestId(LANDING))
      await expect(box, 'non-vacuity: friend A really unticked it').toHaveAttribute('aria-checked', 'false')
    }
    await record('explainer-gate')
    await page.getByTestId('explainer-done').click()
    await expect(page).toHaveURL(home)
  }

  await expectLanding(page)
  await record('landing')

  // ⚠ PI-T3 · 18 §UC-PI-005/016 — the archive fold (`showArchive`) and the
  // „Nastavenia odberu" modal (`subCoffee`/`subBakery`/`subSaving`/`subError`) are
  // GONE from this walk because the surfaces are: both were named in the six-leak
  // history this file exists for, and both are UNREACHABLE rather than unwatched —
  // their refs were deleted with the controls. PI-T12 replaced them with the drawer.

  // ── 1. the drawer itself — its header carries the friend's NAME, the one place a
  // friend's identity renders (§UC-PI-003), so it is a stop in its own right. And it is
  // where the walk checks its OWN coverage: every row the drawer offers is one below.
  await openMenu(page)
  const rows = await page.locator('[data-menu-item]').evaluateAll((els) => els.map((el) => el.dataset.menuItem))
  expect(rows.length, 'non-vacuity: the drawer\'s rows were read').toBeGreaterThanOrEqual(6)
  expect(rows.filter((key) => !WALKED_ROWS.includes(key)),
    'a drawer row this walk does not visit — add its stop to walkAuthenticated()').toEqual([])
  await record('drawer')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Menu' })).toHaveCount(0)

  // ── 2. „Moje objednávky" — the history view, with its one round EXPANDED.
  // Expanding is this view's „tick": `expandedRound` and the `roundLines` cache are
  // exactly the per-session state the boundary must drop.
  await menuGo(page, 'Moje objednávky')
  await expect(page).toHaveURL(/\/moje-objednavky$/)
  const round = page.getByTestId('history-round')
  await expect(round, 'the stubbed round is the only one').toHaveCount(1)
  // B arrives with NOTHING expanded — A's expansion must not be B's (the history
  // twin of invariant 4, positional, so asserted before B's own click).
  await expect(round, `${label || 'A'}: no round is expanded on arrival`).toHaveAttribute('aria-expanded', 'false')
  await record('history')
  await round.click()
  await expect(round).toHaveAttribute('aria-expanded', 'true')
  // …and the lines it paints are THIS friend's, fetched now — not a cache from before.
  if (self) await expect(round.getByTestId('history-line')).toContainText(historyLine(self.id))
  await record('history-expanded')

  // ── 3. „Zostatok a platby" — the view, then its Platba modal.
  await menuGo(page, 'Zostatok a platby')
  await expect(page).toHaveURL(/\/zostatok$/)
  await record('balance')
  await page.getByTestId('pay-balance').click()
  let dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // …quoting THIS friend's block, fetched for this session (the per-friend stub).
  if (self) await expect(dialog.getByTestId('payment-vs')).toContainText(balanceFor(self.id).variable_symbol)
  if (fill) await fillEverything(dialog)
  await record('balance-payment')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // ── 4. „Ako to funguje" from the DRAWER — the same view as the gate, WITHOUT the
  // checkbox (`asGate` false), which is why the gate above is its own stop.
  await menuGo(page, 'Ako to funguje')
  await expect(page).toHaveURL(/\/ako-to-funguje$/)
  await expect(page.getByRole('checkbox', { name: 'Už mi to neukazovať' }), 'the drawer\'s explainer is not the gate')
    .toHaveCount(0)
  if (fill) await fillEverything(page.getByTestId(LANDING))
  await record('explainer')
  await page.getByTestId('explainer-done').click()
  await expect(page).toHaveURL(home)

  // ── 5. Profil — the modal and its password fold (UC-FL-004/009).
  await openProfile(page)
  dialog = page.getByRole('dialog')
  await expect(dialog.locator('.m-title')).toHaveText('Upraviť profil')
  const fold = dialog.getByRole('button', { name: 'Zmeniť heslo' })
  if (await fold.count()) await fold.first().click()
  if (fill) await fillEverything(dialog)
  await record('profile')
  await dialog.getByRole('button', { name: 'Zrušiť' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // ── 6. „Pozvať priateľa" — the drawer row (the appbar chip opens the same modal).
  await menuGo(page, 'Pozvať priateľa')
  dialog = page.getByRole('dialog')
  await expect(dialog.locator('.m-title')).toHaveText('Pozvi priateľa')
  await expect(dialog.locator('.copyrow, .banner.danger.slim')).toHaveCount(1)
  if (fill) await fillEverything(dialog)
  await record('invite')
  // Unscoped on purpose: NeoModal's × is named "Zatvoriť dialóg" (02 §UC-DS-010),
  // so exactly one control in this dialog answers to "Zavrieť" — the footer
  // button. ⚠ Playwright matches `name` as a case-insensitive SUBSTRING, so this
  // is a real guard: it also fails if the × is renamed to anything CONTAINING
  // "Zavrieť", which is how the first attempt at that amendment went wrong.
  await dialog.getByRole('button', { name: 'Zavrieť' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // ── 7. „Zdieľať s kolegami" — drawer item 4, present only while the landing's
  // round is OPEN (§UC-PI-004), hence the guard; it depends on the database's state,
  // not on this file's stubs (the stubbed round is completed and never outranks an
  // open one). The walk records whether it ran, and the modern test asserts it did.
  const menu = await openMenu(page)
  const share = menu.getByRole('button', { name: 'Zdieľať s kolegami' })
  if (await share.count()) {
    await share.click()
    dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    if (fill) await fillEverything(dialog)
    await record('share')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } else {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Menu' })).toHaveCount(0)
  }

  return snaps
}

/**
 * The three invariants. `allowed` is what the SECOND friend may legitimately see
 * in a field — their own profile, and nothing else.
 */
function assertNoCarryOver(snaps, allowed) {
  expect(snaps.length, 'the walk must have produced snapshots').toBeGreaterThan(0)
  for (const s of snaps) {
    // 1. Nothing typed in the previous session survives anywhere in the render.
    expect(s.html, `${s.label}: rendered content carries a previous session's sentinel`)
      .not.toContain('SENTINEL-')

    for (const f of s.fields) {
      if (!f.visible) continue
      if (f.type === 'checkbox' || f.type === 'radio') continue
      const who = `${s.label}: ${f.id || f.name || f.placeholder || '(anonymous field)'}`

      // 2. A password field must still be masked. `showLoginPassword` inverted
      //    exactly this across a logout (RD-FL-6): the next person's own password
      //    rendered in cleartext with no action by them.
      //    ⚠ The `placeholder` term is not padding: the credential-setup
      //    dialog's two password inputs and the legacy shared-password input
      //    carry NO `autocomplete`, `id` or `name` at all — so without it the one
      //    surface that both holds a plaintext password AND auto-renders for the
      //    next person sat entirely outside this invariant. It is still not
      //    total (setup's first field says only "Minimálne 4 znaky"), which is
      //    exactly why invariant 4 below keys on the toggle instead of the field.
      const passwordish =
        f.autocomplete.includes('password') ||
        /password|heslo/i.test(f.id) ||
        /password|heslo/i.test(f.name) ||
        /password|heslo/i.test(f.placeholder)
      if (passwordish) expect(f.type, `${who} must render masked`).toBe('password')

      // 3. Every field is empty, or holds THIS friend's own data.
      expect(allowed, `${who} holds a value this session cannot account for: ${JSON.stringify(f.value)}`)
        .toContain(f.value)
    }

    // 4. Nothing is ENGAGED on B's surface. The walk presses no toggle when
    //    `fill: false`, so any `aria-pressed="true"` here was pressed by the
    //    PREVIOUS session — which is precisely RD-FL-6's `showLoginPassword`
    //    (`type="text"` on the next person's own password field). Stated as a
    //    property of the control class rather than of a ref, so a future reveal
    //    toggle anywhere on this surface inherits the cover for free.
    for (const t of s.toggles) {
      if (!t.visible) continue
      expect(t.pressed, `${s.label}: toggle "${t.name}" is engaged in a session that never pressed it`)
        .toBe('false')
    }
  }
}

// ---------------------------------------------------------------------------

test.describe('⚠ nothing crosses the session boundary (the whole friend surface)', () => {
  test('modern login: one component instance, friend A seeds every field, friend B sees none of it', async ({ page }) => {
    // ⚠ `ack: false` — both friends meet the first-login explainer GATE, which is a
    // stop of the walk (see `makeFriend`).
    const a = await makeFriend('a', PASSWORD_A, { ack: false })
    const b = await makeFriend('b', PASSWORD_B, { ack: false })
    expect(a.password, 'the secret sweep needs two distinct passwords').not.toBe(b.password)

    await muteGuestCounts(page)
    await stubWalkData(page)
    // Modern login card = a form both friends can authenticate through without a
    // reload. Per page only; the shared seed stays legacy.
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'modern' } }))
    await page.addInitScript(() => localStorage.clear())

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Kto klope?' })).toBeVisible()

    // --- the LOGIN surface is part of the walk too: it is where the eye toggle
    // lives, and `showLoginPassword` is the leak the reviewer found by sweeping.
    await fillEverything(page.locator('.app'))
    await expect(page.locator('#pp-login-password')).toHaveAttribute('type', 'text')

    async function loginAs(who) {
      await page.locator('#pp-login-username').fill(who.username)
      await page.locator('#pp-login-password').fill(who.password)
      await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
      await expectLanding(page)
    }

    await loginAs(a)
    await walkAuthenticated(page, { fill: true, gate: true, self: a })

    // --- the boundary itself
    await logout(page)
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')

    const snaps = [await snapshot(page, 'login-after-logout')]
    await loginAs(b)
    await walkAuthenticated(page, { fill: false, snaps, label: 'B', gate: true, self: b })

    // ⚠ Non-vacuity for the WALK itself (PI-T12): every drawer stop really produced a
    // snapshot. „Zdieľať s kolegami" is the one conditional stop (the landing's round
    // must be OPEN), and the gate database always has one — `seed.mjs`'s open
    // „E2E Test Cycle" — so on this target a missing share snapshot is a lost stop.
    expect(snaps.map((x) => x.label)).toEqual([
      'login-after-logout', 'B:explainer-gate', 'B:landing', 'B:drawer', 'B:history',
      'B:history-expanded', 'B:balance', 'B:balance-payment', 'B:explainer', 'B:profile',
      'B:invite', 'B:share',
    ])

    // ⚠ `b.phone` joins the allow-list (18 §UC-PI-015, PI-T10): the profile modal now
    // renders a required Mobil, so B's own number is a legitimate field value. A's is
    // swept as a secret two lines down, which is what keeps invariant 3 meaningful.
    assertNoCarryOver(snaps, ['', b.name, b.username, b.uid, b.packeta, b.phone])

    // Belt and braces on the thing the three invariants abstract over: NOTHING
    // that identifies friend A may appear anywhere on friend B's screen —
    // rendered text as well as field values. The invite code is in this list
    // because it is not a "value the user typed" (so `SENTINEL-` cannot cover
    // it) and it is an identity: whoever registers through it is credited to A.
    const values = snaps.flatMap((s) => s.fields.map((f) => f.value)).filter(Boolean)
    // `historyLine(a.id)` (PI-T12): A's expanded round painted it; B's must never. Same
    // for A's money block — amount, reference, variable symbol (PI-T12 review).
    for (const secret of [a.name, a.username, a.password, a.uid, a.inviteCode, a.phone, historyLine(a.id), ...balanceSecrets(a.id)]) {
      expect(values, `${secret} in a field B can see: ${JSON.stringify(values)}`).not.toContain(secret)
      for (const s of snaps) {
        expect(s.html, `${s.label}: renders friend A's ${secret}`).not.toContain(secret)
      }
    }
    // …and B's own profile really did re-derive, so invariant 3 is not passing
    // merely because every field happens to be blank.
    expect(values).toContain(b.name)
    // Same anti-vacuity check for invariant 4: only the LOGIN screen carries an
    // `[aria-pressed]` control today (the eye toggle), so if that snapshot ever
    // stops being taken — or the toggle stops exposing the attribute — invariant
    // 4 would quietly iterate over nothing and pass forever.
    expect(snaps.flatMap((s) => s.toggles).length, 'invariant 4 had nothing to check')
      .toBeGreaterThan(0)
  })

  test('transition mode: the AUTO-RAISED credential-setup dialog is part of that surface', async ({ page }) => {
    // The setup dialog needs no action from the next person — `authenticate()`
    // re-raises it for ANY transition-mode friend without personal credentials.
    // It is therefore the one surface where a leak renders itself, which is why
    // the walk covers it under its own auth mode rather than skipping it.
    const a = await makePlainFriend('ta')
    const b = await makePlainFriend('tb')

    await muteGuestCounts(page)
    await stubWalkData(page)
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'transition' } }))
    await page.route('**/api/friends/login-list', (route) =>
      route.fulfill({
        json: [
          { id: a.id, name: a.name, hasCredentials: false },
          { id: b.id, name: b.name, hasCredentials: false },
        ],
      })
    )
    await page.addInitScript(() => localStorage.clear())

    /** Shared-password login; returns the auto-raised setup dialog. */
    async function sharedLogin(who) {
      await page.getByRole('combobox').click()
      await page.getByRole('option', { name: who.name }).click()
      await page.getByPlaceholder('Zadajte heslo').fill(FRIENDS_PASSWORD)
      await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
      const d = page.getByRole('dialog')
      await expect(d.getByRole('heading', { name: 'Nastavte si osobné prihlásenie' })).toBeVisible()
      return d
    }

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Prihlásenie' })).toBeVisible()

    const setup = await sharedLogin(a)
    await fillEverything(setup)
    // "Neskôr" — every cancel path leaks, because `saveCredentials()` clears
    // these on its SUCCESS path only.
    await setup.getByRole('button', { name: 'Neskôr' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await walkAuthenticated(page, { fill: true, self: a })

    await logout(page)
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')

    const reopened = await sharedLogin(b)
    const snaps = [await snapshot(page, 'B:credential-setup')]
    await reopened.getByRole('button', { name: 'Neskôr' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await walkAuthenticated(page, { fill: false, snaps, label: 'B', self: b })

    // ⚠ `b.phone` — see the modern-login test above (18 §UC-PI-015, PI-T10).
    assertNoCarryOver(snaps, ['', b.name, b.uid, b.phone])
    for (const s of snaps) {
      for (const secret of [historyLine(a.id), ...balanceSecrets(a.id)]) {
        expect(s.html, `${s.label}: renders friend A's ${secret}`).not.toContain(secret)
      }
    }
  })

  // -------------------------------------------------------------------------
  // The class the four invariants DO NOT cover: an in-flight flag left true.
  // -------------------------------------------------------------------------
  //
  // A leaked `setupSaving` renders nothing and fills no field — it renders as
  // DISABLEDNESS, which is why it needs its own assertion rather than a fifth
  // invariant (plenty of controls are legitimately disabled, e.g. "Nastaviť"
  // with empty fields, so "no disabled control on B's surface" would be false).
  //
  // ⚠ Reachability is the whole point, and it does NOT go through the logout
  // button: while a modal is open the scrim covers the appbar. It goes through
  // Esc — radix closes this dialog regardless of a disabled footer, and
  // `saveCredentials()`'s `finally` only runs when the request SETTLES. So
  // "submit → Esc → logout" leaves the flag set with the request still in
  // flight, and `authenticate()` then AUTO-RAISES the same dialog for the next
  // transition-mode friend without credentials — who gets an inert dialog they
  // did nothing to summon, both of whose footer buttons are `:disabled`.
  test('⚠ a save still in flight when the session ends must not disable the NEXT person\'s dialog', async ({ page }) => {
    const a = await makePlainFriend('ia')
    const b = await makePlainFriend('ib')

    await muteGuestCounts(page)
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'transition' } }))
    await page.route('**/api/friends/login-list', (route) =>
      route.fulfill({
        json: [
          { id: a.id, name: a.name, hasCredentials: false },
          { id: b.id, name: b.name, hasCredentials: false },
        ],
      })
    )

    // Hold the setup request open for the whole test; released in `finally` so a
    // failure never strands the route handler.
    let releaseSetup = () => {}
    const held = new Promise((resolve) => { releaseSetup = resolve })
    await page.route('**/api/friends/*/setup-credentials', async (route) => {
      await held
      await route.abort()
    })

    await page.addInitScript(() => localStorage.clear())

    async function sharedLogin(who) {
      await page.getByRole('combobox').click()
      await page.getByRole('option', { name: who.name }).click()
      await page.getByPlaceholder('Zadajte heslo').fill(FRIENDS_PASSWORD)
      await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
      const d = page.getByRole('dialog')
      await expect(d.getByRole('heading', { name: 'Nastavte si osobné prihlásenie' })).toBeVisible()
      return d
    }

    try {
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'Prihlásenie' })).toBeVisible()

      const setup = await sharedLogin(a)
      // Client-side validation must PASS, or the request is never issued and the
      // flag never rises — this test would then be green for the wrong reason.
      await setup.getByPlaceholder('napr. janko_hrasko').fill(`rdfl7flag${uniq()}`.toLowerCase().slice(0, 30))
      // ⚠ 11 chars: the placeholder says "Minimálne 4 znaky" but
      // `saveCredentials()` rejects anything under 8 (a shipped inconsistency,
      // not this row's to fix). A 4-char password would fail validation, issue
      // no request, and make this test pass for the wrong reason.
      await setup.getByPlaceholder('Minimálne 4 znaky').fill('inflight123')
      await setup.getByPlaceholder('Zopakujte heslo').fill('inflight123')
      await setup.getByRole('button', { name: 'Nastaviť' }).click()

      // The flag really is up: the submit button is showing its in-flight label.
      await expect(setup.getByRole('button', { name: 'Ukladám...' })).toBeVisible()

      // Esc — the escape hatch the disabled footer does not close off.
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)

      await logout(page)
      await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')

      const next = await sharedLogin(b)
      // B did nothing to summon this dialog and must be able to dismiss it…
      await expect(next.getByRole('button', { name: 'Neskôr' }), 'B cannot dismiss an auto-raised dialog')
        .toBeEnabled()
      // …and the submit control must read its at-rest label, not A's "Ukladám...".
      await expect(next.getByRole('button', { name: 'Nastaviť' })).toBeVisible()
      await expect(next.getByRole('button', { name: 'Ukladám...' })).toHaveCount(0)
    } finally {
      releaseSetup()
    }
  })
})
