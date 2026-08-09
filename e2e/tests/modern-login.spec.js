import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-FL-2 — the redesigned MODERN login (03 §UC-FL-002) and the forced
// password-change gate (03 §UC-FL-012), plus the first real browser regression
// net for the 02 primitives: BrandChrome, NeoIcon, NeoCheckbox and NeoModal
// (02 §UC-DS-014 item 6 — 03 is the primitives' first net).
//
// ⚠ THE SHARED SEED IS LEGACY AND MUST STAY LEGACY. `e2e/seed.mjs` sets
// `auth_mode = 'legacy'`, and `public-flow.spec.js` / `friend-login-list.spec.js`
// assert the legacy card ("Prihlásenie", the name combobox).
//
// ⚠ So this file NEVER WRITES `auth_mode`. It stubs the one endpoint the view
// reads it from — `FriendPortal.vue` → `api.getAuthMode()` → `GET
// /friends/auth-mode` — per `page`, in `beforeEach`. `page.route` outlives
// navigations, so every `goto`/reload in the file is covered.
//
// Flipping the setting for real (the first cut of this file) was global,
// unserialized state:
//   1. `PUT /api/admin/settings` DELETES every row of `friend_sessions` when the
//      mode actually changes (`backend/src/routes/admin.js:171`) — twice per run,
//      once per flip.
//   2. `fullyParallel: false` does NOT serialize FILES, and the config pins no
//      `workers`, so Playwright uses `cpus/2`. On any ≥4-core host a concurrently
//      scheduled `public-flow` / `friend-login-list` would see the modern card
//      and lose its session.
//   3. If the worker died before `afterAll` — crash, Ctrl-C, `--max-failures` —
//      `auth_mode` stayed `modern` and every later legacy spec failed with a
//      misleading error.
// The stub has none of those, and needs no restore that can itself fail. The
// `afterAll` below asserts the server's real mode is still `legacy`, which is
// the actual pin on all three.
//
// This works — and is honest — because the backend's personal-login branch
// (`POST /friends/auth` with a `username`) is NOT gated on `auth_mode`; only the
// FRONTEND branch selection is. Every request other than the mode probe still
// goes to the real backend, so the login, the forced-change gate and the cycle
// list are all exercised for real.

const ADMIN_TIMEOUT = 20_000

// --- provisioning helpers ---------------------------------------------------

let ctx = null
let adminToken = ''

/** Friend with working personal credentials and NO forced-change flag. */
let cleanFriend = null
/** Friend whose password was just admin-reset ⇒ `must_change_password = 1`. */
let resetFriend = null

const CLEAN_PASSWORD = 'friendChosen9'
const ADMIN_SET_PASSWORD = 'adminSet12345'

/**
 * Create a friend with a username + a known personal password.
 *
 * `PUT /friends/:id/reset-password` is the only admin-side way to set a
 * password, and it always raises `must_change_password`. For the "clean" friend
 * we therefore log in over the API once and change the password, which clears
 * the flag — exactly the flow a real friend goes through.
 */
async function makeFriend(label, { clearForcedChange }) {
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  const name = `RDFL2 ${label} ${uniq}`
  const username = `rdfl2${label}${uniq}`.toLowerCase()

  const created = await ctx.post('/api/friends', {
    headers: { 'X-Admin-Token': adminToken },
    data: { name },
    timeout: ADMIN_TIMEOUT,
  })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()

  const named = await ctx.put(`/api/friends/${friend.id}/admin-username`, {
    headers: { 'X-Admin-Token': adminToken },
    data: { username },
    timeout: ADMIN_TIMEOUT,
  })
  expect(named.status(), 'admin-username').toBe(200)

  const reset = await ctx.put(`/api/friends/${friend.id}/reset-password`, {
    headers: { 'X-Admin-Token': adminToken },
    data: { password: ADMIN_SET_PASSWORD },
    timeout: ADMIN_TIMEOUT,
  })
  expect(reset.status(), 'reset-password').toBe(200)

  let password = ADMIN_SET_PASSWORD
  if (clearForcedChange) {
    const auth = await ctx.post('/api/friends/auth', {
      data: { username, password: ADMIN_SET_PASSWORD },
      timeout: ADMIN_TIMEOUT,
    })
    expect(auth.status(), 'personal auth').toBe(200)
    const { token, mustChangePassword } = await auth.json()
    expect(mustChangePassword, 'an admin reset must flag the friend').toBe(true)

    const changed = await ctx.put(`/api/friends/${friend.id}/change-password`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { currentPassword: ADMIN_SET_PASSWORD, newPassword: CLEAN_PASSWORD },
      timeout: ADMIN_TIMEOUT,
    })
    expect(changed.status(), 'change-password').toBe(200)
    password = CLEAN_PASSWORD
  }

  return { ...friend, username, password }
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: ADMIN_TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  cleanFriend = await makeFriend('clean', { clearForcedChange: true })
  resetFriend = await makeFriend('reset', { clearForcedChange: false })
})

test.afterAll(async () => {
  // ⚠ The hermeticity pin, asserted rather than assumed: this file must leave
  // the shared seed's `auth_mode` exactly as it found it. If a future edit
  // reintroduces a settings PUT, this fails here instead of surfacing as an
  // unrelated legacy spec breaking three files later.
  if (ctx) {
    const mode = await ctx.get('/api/friends/auth-mode', { timeout: ADMIN_TIMEOUT })
    expect(mode.status(), 'auth-mode probe').toBe(200)
    expect((await mode.json()).authMode, 'this file must not write auth_mode').toBe('legacy')
    await ctx.dispose()
  }
})

// --- helpers ---------------------------------------------------------------

// The whole file renders the MODERN card without touching server state. Routes
// registered on `page` survive navigation, so one registration covers every
// `goto` and reload below.
test.beforeEach(async ({ page }) => {
  await page.route('**/friends/auth-mode', (route) =>
    route.fulfill({ json: { authMode: 'modern' } })
  )
})

async function freshVisit(page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
}

async function loginAs(page, friend, { viaEnter = false } = {}) {
  await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
  await page.getByLabel(/^heslo$/i).fill(friend.password)
  if (viaEnter) await page.getByLabel(/^heslo$/i).press('Enter')
  else await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
}

// ---------------------------------------------------------------------------

test.describe('Modern login — the redesigned card (UC-FL-002)', () => {
  test('renders the Neobrutal login: chrome, headline, fields, remember-me, explainer', async ({ page }) => {
    await freshVisit(page)

    // BrandChrome (UC-DS-006) — appbar wordmark, rotated chip, hazard, ticker.
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
    await expect(page.locator('.appbar .titles .s')).toHaveText('Členský vstup')
    await expect(page.locator('.appbar .chip.acc')).toHaveText('Len pre svojich')
    await expect(page.locator('.hazard')).toBeVisible()
    await expect(page.locator('.ticker')).toContainText('VSTUP LEN PRE SVOJICH')

    // The headline is a real <h1> whose accessible name concatenates the .hl span.
    const headline = page.getByRole('heading', { name: /^kto klope\?$/i, level: 1 })
    await expect(headline).toBeVisible()
    await expect(headline).toHaveClass(/h-screen/)
    await expect(headline.locator('.hl')).toHaveText('klope?')
    // ⚠ `h-screen` is the THEME's display-heading class here, not Tailwind's
    // height utility. Tailwind's JIT emits `.h-screen{height:100vh}` as soon as
    // the name appears in any scanned source, and it lands at the same
    // specificity as the theme rule on a different property — so both apply and
    // the headline becomes a whole viewport tall. `tailwind.config.js`
    // blocklists the candidate; this is what proves the block is still in place.
    const headlineBox = await headline.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      viewport: window.innerHeight,
    }))
    expect(headlineBox.height, JSON.stringify(headlineBox)).toBeLessThan(headlineBox.viewport / 2)
    await expect(page.getByText('Prihláste sa užívateľským menom a heslom.')).toBeVisible()

    // ⚠ The modern card must NOT carry the legacy "Prihlásenie" title.
    await expect(page.getByText('Prihlásenie', { exact: true })).toHaveCount(0)
    // …nor the legacy hero image or name dropdown.
    await expect(page.locator('img[src="/coffee-cup.png"]')).toHaveCount(0)
    await expect(page.getByRole('combobox')).toHaveCount(0)

    // Fields — native inputs with the theme classes, label-associated.
    const username = page.getByLabel(/^užívateľské meno$/i)
    await expect(username).toHaveClass(/\binp\b/)
    await expect(username).toHaveAttribute('placeholder', 'napr. lego')
    await expect(username).toHaveAttribute('autocomplete', 'username')
    await expect(username).toHaveAttribute('autocapitalize', 'none')

    const password = page.getByLabel(/^heslo$/i)
    await expect(password).toHaveClass(/\binp\b/)
    await expect(password).toHaveAttribute('placeholder', 'Zadajte heslo')
    await expect(password).toHaveAttribute('type', 'password')
    await expect(password).toHaveAttribute('autocomplete', 'current-password')

    // NeoCheckbox (UC-DS-009) — remember-me, default ON.
    const remember = page.getByRole('checkbox', { name: 'Zapamätať si ma na tomto zariadení' })
    await expect(remember).toHaveClass(/\bcbox\b/)
    await expect(remember).toHaveAttribute('aria-checked', 'true')
    await remember.click()
    await expect(remember).toHaveAttribute('aria-checked', 'false')
    await remember.press(' ')
    await expect(remember).toHaveAttribute('aria-checked', 'true')

    // The dashed invite explainer + its NeoIcon "lock" glyph.
    const explainer = page.locator('.card.dashed')
    await expect(explainer).toHaveText(
      'Nemáte účet? Podpultovka je na pozvánky — požiadajte kamoša, ktorý už objednáva, alebo si objednajte cez jeho odkaz bez účtu.'
    )
    await expect(explainer.locator('svg')).toHaveCount(1)

    // Magenta block submit, disabled until both fields are filled.
    const submit = page.getByRole('button', { name: 'Prihlásiť sa' })
    await expect(submit).toHaveClass(/\bbtn\b.*\baccent\b.*\bblock\b/)
    await expect(submit).toBeDisabled()
    await username.fill('someone')
    await expect(submit).toBeDisabled()
    await password.fill('something')
    await expect(submit).toBeEnabled()
  })

  test('the eye toggle switches only the input type — value kept, colour flips', async ({ page }) => {
    await freshVisit(page)

    const password = page.getByLabel(/^heslo$/i)
    await password.fill('tajneheslo')
    await expect(password).toHaveAttribute('type', 'password')

    const eye = page.getByRole('button', { name: 'Zobraziť heslo' })
    await expect(eye).toHaveCSS('color', 'rgba(10, 10, 10, 0.66)') // var(--ink-dim)
    await eye.click()

    await expect(password).toHaveAttribute('type', 'text')
    await expect(password).toHaveValue('tajneheslo')
    await expect(page.getByRole('button', { name: 'Skryť heslo' })).toHaveCSS('color', 'rgb(255, 45, 135)') // var(--accent)

    await page.getByRole('button', { name: 'Skryť heslo' }).click()
    await expect(password).toHaveAttribute('type', 'password')
    await expect(password).toHaveValue('tajneheslo')
    await expect(eye).toHaveCSS('color', 'rgba(10, 10, 10, 0.66)')
  })

  test('input.inp:focus paints the 3px accent shadow (ported CSS reaches this view)', async ({ page }) => {
    await freshVisit(page)
    const username = page.getByLabel(/^užívateľské meno$/i)
    await username.focus()
    await expect(username).toHaveCSS('box-shadow', 'rgb(255, 45, 135) 3px 3px 0px 0px')
  })

  test('a wrong password shows the server message in .banner.danger.slim', async ({ page }) => {
    await freshVisit(page)
    await page.getByLabel(/^užívateľské meno$/i).fill(cleanFriend.username)
    await page.getByLabel(/^heslo$/i).fill('definitelyWrong1')
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()

    const banner = page.locator('.banner.danger.slim')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Nesprávne prihlasovacie údaje')
    // Still on the login card.
    await expect(page.getByRole('heading', { name: /^kto klope\?$/i, level: 1 })).toBeVisible()
  })

  test('the empty-field guard keeps its verbatim message', async ({ page }) => {
    await freshVisit(page)
    // The button is disabled while a field is empty, so drive the same guard the
    // way a keyboard user reaches it: Enter in the password field.
    await page.getByLabel(/^užívateľské meno$/i).fill(cleanFriend.username)
    await page.getByLabel(/^heslo$/i).press('Enter')
    await expect(page.locator('.banner.danger.slim')).toHaveText(/Zadajte užívateľské meno a heslo/)
  })

  test('a successful login lands on the cycle list, and Enter in the password field submits', async ({ page }) => {
    await freshVisit(page)
    await loginAs(page, cleanFriend, { viaEnter: true })

    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    // Remember-me defaults to true ⇒ the pinned session shape is written.
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gorifi_friend_auth') || 'null'))
    expect(stored).toMatchObject({ friendId: cleanFriend.id, friendName: cleanFriend.name })
    expect(typeof stored.token).toBe('string')
    expect(typeof stored.friendUid).toBe('string')
    // The title contract survives the redesign.
    await expect(page).toHaveTitle(/Gorifi/)
  })

  test('remember-me off keeps the session in memory only', async ({ page }) => {
    await freshVisit(page)
    await page.getByRole('checkbox', { name: 'Zapamätať si ma na tomto zariadení' }).click()
    await loginAs(page, cleanFriend)

    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('gorifi_friend_auth'))).toBeNull()
  })

  test('no horizontal overflow at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await freshVisit(page)
    await expect(page.getByRole('heading', { name: /^kto klope\?$/i, level: 1 })).toBeVisible()
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth)
  })
})

// ---------------------------------------------------------------------------

test.describe('Forced password change — the non-dismissable NeoModal gate (UC-FL-012)', () => {
  /** Is the focused element inside the gate? */
  const focusInsideGate = (page) =>
    page.evaluate(() => {
      const modal = document.querySelector('[data-testid="forced-password-change"]')
      if (!modal) return { inside: false, tag: 'NO-MODAL' }
      const active = document.activeElement
      return {
        inside: modal.contains(active),
        tag: active ? `${active.tagName}${active.id ? '#' + active.id : ''}` : 'NONE',
      }
    })

  test('appears after an admin-reset login and cannot be dismissed', async ({ page }) => {
    await freshVisit(page)
    await loginAs(page, resetFriend)

    const gate = page.getByTestId('forced-password-change')
    await expect(gate).toBeVisible()
    await expect(gate).toHaveAttribute('role', 'dialog')
    await expect(gate).toHaveAttribute('aria-modal', 'true')
    await expect(gate).toContainText('Administrátor vám resetoval heslo')
    // closable:false ⇒ no × at all (UC-DS-010).
    await expect(gate.locator('.m-x')).toHaveCount(0)

    // Esc must not dismiss it.
    await page.keyboard.press('Escape')
    await expect(gate).toBeVisible()

    // Neither may a click on the scrim (top-left corner, away from the card).
    await page.locator('.modal-scrim').click({ position: { x: 4, y: 4 } })
    await expect(gate).toBeVisible()

    // The page behind is scroll-locked while the gate is open.
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
  })

  test('⚠ Tab and Shift+Tab cannot escape the gate (NeoModal focus trap)', async ({ page }) => {
    await freshVisit(page)
    await loginAs(page, resetFriend)
    await expect(page.getByTestId('forced-password-change')).toBeVisible()

    // Forward: 12 presses is more than twice the number of focusables inside,
    // so a missing trap lands on the page behind the scrim well within it.
    const forward = []
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      const state = await focusInsideGate(page)
      forward.push(state.tag)
      expect(state.inside, `Tab #${i + 1} escaped the gate → ${JSON.stringify(forward)}`).toBe(true)
    }
    // …and it genuinely CYCLES rather than parking on one element.
    expect(new Set(forward).size, `Tab did not move focus: ${JSON.stringify(forward)}`).toBeGreaterThan(1)

    // Backward.
    const backward = []
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab')
      const state = await focusInsideGate(page)
      backward.push(state.tag)
      expect(state.inside, `Shift+Tab #${i + 1} escaped the gate → ${JSON.stringify(backward)}`).toBe(true)
    }
    expect(new Set(backward).size, `Shift+Tab did not move focus: ${JSON.stringify(backward)}`).toBeGreaterThan(1)
  })

  test('validation messages are verbatim and render in .banner.danger.slim', async ({ page }) => {
    await freshVisit(page)
    await loginAs(page, resetFriend)
    const gate = page.getByTestId('forced-password-change')
    await expect(gate).toBeVisible()

    await gate.getByLabel(/^nové heslo$/i).fill('short1')
    await gate.getByLabel(/^potvrdiť nové heslo$/i).fill('short1')
    await gate.getByRole('button', { name: 'Nastaviť heslo a pokračovať' }).click()
    await expect(gate.locator('.banner.danger.slim')).toHaveText(/Nové heslo musí mať aspoň 8 znakov/)

    await gate.getByLabel(/^nové heslo$/i).fill('longEnough1')
    await gate.getByLabel(/^potvrdiť nové heslo$/i).fill('longEnough2')
    await gate.getByRole('button', { name: 'Nastaviť heslo a pokračovať' }).click()
    await expect(gate.locator('.banner.danger.slim')).toHaveText(/Heslá sa nezhodujú/)

    // Still blocking — nothing behind it is reachable yet.
    await expect(gate).toBeVisible()
  })

  test('setting a valid password closes the gate and lands on the cycle list', async ({ page }) => {
    // A fresh reset friend, because this test consumes the forced-change state.
    const friend = await makeFriend('gate', { clearForcedChange: false })
    await freshVisit(page)
    await loginAs(page, friend)

    const gate = page.getByTestId('forced-password-change')
    await expect(gate).toBeVisible()

    // Enter in the confirm field submits.
    await gate.getByLabel(/^nové heslo$/i).fill('novéHeslo123')
    await gate.getByLabel(/^potvrdiť nové heslo$/i).fill('novéHeslo123')
    await gate.getByLabel(/^potvrdiť nové heslo$/i).press('Enter')

    await expect(gate).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    // The scroll lock is released and the body's inline overflow restored.
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('')

    // The new password really took: a fresh login with it needs no gate.
    await freshVisit(page)
    await loginAs(page, { ...friend, password: 'novéHeslo123' })
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    await expect(page.getByTestId('forced-password-change')).toHaveCount(0)
  })
})
