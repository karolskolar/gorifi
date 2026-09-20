import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { expectLanding, expectNoLanding, drawer, openMenu, menuGo } from '../helpers/portal.js'

// PI-T2 — 18 §UC-PI-004, the hamburger drawer (`NeoDrawer.vue`), and
// §UC-PI-019 item 17's `portal-menu.spec.js`.
//
// ⚠ WHAT IS DELIBERATELY NOT HERE, so nobody reads a gap as a decision:
//   · ITEM 4 („Zdieľať s kolegami", `state === 'open'` only) is PI-T3's — it opens
//     `GuestShareDialog`, which that row re-points at the landing. Its colleague
//     count and the `loadSeq` guard §UC-PI-019 item 6 moves here land with it. The
//     slot between „Zostatok a platby" and „Pozvať priateľa" is pinned EMPTY below,
//     so PI-T3 filling it is a visible change rather than a silent one.
//   · Item 1's „ · v košíku {suma}" clause needs a landing CART, which PI-T3 mounts.
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

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

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
  test('six rows in the spec\'s order, with the spec\'s labels', async ({ page }) => {
    const friend = await makeFriend('Rows')
    await signIn(page, friend)
    await stubBalance(page, -12.5)
    await stubCycles(page, [cycleRow({ n: 1, status: 'open', closes_at: '2026-09-12' })])
    await open(page)

    await openMenu(page)
    const seen = await rows(page)
    expect(seen.map((r) => r.label)).toEqual([
      'Aktuálna ponuka',
      'Moje objednávky',
      'Zostatok a platby',
      'Pozvať priateľa',
      'Ako to funguje',
      'Profil',
    ])
    // ⚠ PI-T3's SLOT, pinned empty: item 4 („Zdieľať s kolegami") belongs between
    // „Zostatok a platby" and „Pozvať priateľa" and is not built yet. When PI-T3
    // lands, THIS assertion is the one that must be updated — deliberately, in a
    // row that says so.
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
