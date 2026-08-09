import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-KG-2 — 05 §UC-KG-006/007: `GuestShareDialog.vue` recomposed onto
// `NeoModal` (02 §UC-DS-010) + `NeoCopyRow` (02 §UC-DS-011).
//
// This is a RE-SKIN of the TEMPLATE ONLY. No API, schema or authorization change:
// `guest-link.spec.js` remains the behavioural contract for the share link, and it
// runs with exactly the two authorized assertion substitutions §UC-KG-007 item 1
// permits (its `guest-link-url` hook moved from a readonly `<input>` to
// NeoCopyRow's `div.copyrow > .val`, so `inputValue()`/`toHaveValue()` have no
// meaning on it any more). Everything ADDED here is what the restyle newly makes
// assertable:
//
//   1. Every body state the spec enumerates, in order: error, loading,
//      no-link-yet, link-exists (active AND deactivated), and the regenerate
//      confirmbox.
//   2. The two hard invariants the copy carries — deactivation is REVERSIBLE, and
//      regeneration KEEPS existing sub-orders (asserted against a real sub-order,
//      not against the wording alone).
//   3. ⚠ THE MOUNT SEAM. `guest-host-view.spec.js:890,929` locate the page-level
//      share affordances with an UNSCOPED `getByRole('button', { name: /Zdieľať/ })`
//      and both specs are immutable. `NeoModal` has no `open` prop — the parent
//      owns the mount — so leaving this dialog mounted while closed would add its
//      own "Zdieľať odkaz" to that set and convert their `toBeHidden()` into a
//      strict-mode violation. The `v-if="open"` that prevents it is pinned below.
//   4. The `loadSeq` reset under that `open`-driven mount, the native-share
//      conditional (and the frozen share-sheet payload), 320px, and the GSO-T2
//      invariant that a guest's `order_token` never reaches a host surface.
//
// NOTE ON RATE LIMITS: the guest submits below sit behind `guestWriteLimiter`. Run
// the full suite with a generous budget — see e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// The backend keeps exactly ONE live admin session, overwritten on every
// /api/admin/login — a UI login elsewhere invalidates a token captured earlier.
async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin re-login').toBe(200)
  adminToken = (await login.json()).token
}

// A friend with a real per-friend Bearer session — the host identity the
// guest-link routes require. Mirrors colleagues-panel.spec.js.
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `kg2_${slug}`.slice(0, 30 - suffix.length) + suffix
  expect(username.length, 'username must fit validateUsername').toBeLessThanOrEqual(30)
  const name = `Peto ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()

  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const body = await login.json()

  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || body.token
  return { id: friend.id, name, token, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label) {
  const name = `E2E KG2 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function setCycleStatus(cycleId, status) {
  expect((await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status } })).status()).toBe(200)
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

async function submitGuest(linkToken, items, identity = { guest_name: 'Juraj Lehotsky', guest_phone: '0905 012 998' }) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

async function hostView(host, cycleId) {
  const res = await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect(res.status(), 'host view').toBe(200)
  return res.json()
}

// FriendPortal resolves the stored session against GET /api/friends?active=true,
// which is admin-gated — an anonymous browser gets 401 (pre-existing app gap, see
// e2e/README.md), so that ONE response is stubbed. Everything under test still
// talks to the real backend with the real Bearer token.
async function signInAsHost(page, host) {
  await page.addInitScript((value) => {
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({ friendId: host.id, friendName: host.name, token: host.token, expiresAt: Date.now() + 864e5 }))

  await page.route('**/api/friends?active=true', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ id: host.id, name: host.name, uid: 'E2EKG2', active: 1, subscriptions: ['coffee', 'bakery'] }]),
  }))
}

async function gotoPortal(page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
}

// A hard load of /cycle/:id bounces to the portal, so a real host arrives through it.
async function gotoCycle(page, cycle) {
  await gotoPortal(page)
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
}

const portalCard = (page, name) =>
  page.locator('div.card.p-4', { has: page.getByRole('heading', { name, exact: true }) })

// Entry point A — the "Kolegovia" panel in FriendOrder (module 05's own).
async function openFromOrderPage(page, host, cycle, { width = 378 } = {}) {
  await page.setViewportSize({ width, height: 900 })
  await signInAsHost(page, host)
  await gotoCycle(page, cycle)
  await page.getByTestId('main-tab-guests').click()
  await page.getByRole('button', { name: /Zdieľať/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

// Entry point B — the portal cycle card's share row (module 03's, same dialog).
async function openFromPortal(page, host, cycle, { width = 378 } = {}) {
  await page.setViewportSize({ width, height: 900 })
  await signInAsHost(page, host)
  await gotoPortal(page)
  await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

const overflow = (page) => page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
}))

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  await refreshAdminToken()
})

test.afterAll(async () => { await ctx?.dispose() })

// ---------------------------------------------------------------------------
// UC-KG-006 — the modal shell

test.describe('UC-KG-006 — the NeoModal shell', () => {
  test('title, the cycle NAME in the subtitle, the "Zavrieť" footer, Escape and the ×', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('shell')
    const cycle = await makeCycle('shell')
    await shareLink(host, cycle.id)

    const dialog = await openFromPortal(page, host, cycle)

    await expect(dialog.locator('.m-title')).toHaveText('Zdieľať s kolegami')
    // ⚠ The dialog MUST name the cycle: several open cycles sit side by side in
    // the portal, so an unlabelled URL cannot be verified (GSO-T2).
    const subtitle = dialog.locator('.m-head .sub')
    await expect(subtitle).toContainText(cycle.name)
    await expect(subtitle.locator('b')).toHaveText(cycle.name)
    await expect(subtitle).toContainText('Kolegovia si objednajú cez váš odkaz — bez registrácie. Zásielku prevezmete vy a odovzdáte im ju.')

    // The shell's own affordances: uppercase display title, 4px ink border.
    expect(await dialog.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('4px')
    expect(await dialog.locator('.m-title').evaluate((el) => getComputedStyle(el).textTransform)).toBe('uppercase')

    // Footer: exactly one "Zavrieť" button, and it closes.
    await expect(dialog.locator('.m-foot button')).toHaveCount(1)
    await dialog.locator('.m-foot button').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // The teleported layer is GONE, not merely hidden — the parent owns the mount.
    await expect(page.locator('.modal-layer')).toHaveCount(0)

    // Reopen: Escape closes too, and the count goes to 0 (guest-link.spec.js's
    // race test depends on exactly this).
    await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // And the ×, whose accessible name must NOT contain "Zavrieť" (02 §UC-DS-010).
    await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
    await page.getByRole('button', { name: 'Zatvoriť dialóg' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// UC-KG-006 — the five body states

test.describe('UC-KG-006 — body states', () => {
  test('no link yet: the `.sub` sentence + the accent block CTA, and nothing else', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('nolink')
    const cycle = await makeCycle('nolink')

    const dialog = await openFromOrderPage(page, host, cycle)

    await expect(dialog.locator('p.sub')).toHaveText('Odkaz ešte nie je vytvorený.')
    const create = dialog.getByRole('button', { name: 'Vytvoriť odkaz' })
    await expect(create).toBeVisible()
    expect(await create.evaluate((el) => el.className)).toContain('accent')
    expect(await create.evaluate((el) => el.className)).toContain('block')
    await expect(dialog.locator('.copyrow'), 'no link ⇒ no copy row').toHaveCount(0)
    await expect(dialog.locator('.banner'), 'and no banner of any kind').toHaveCount(0)
    await expect(dialog.locator('.confirmbox')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Deaktivovať odkaz' })).toHaveCount(0)

    // Creating flips the state in place.
    await create.click()
    await expect(dialog.locator('.copyrow')).toHaveCount(1)
    await expect(dialog.locator('p.sub')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Vytvoriť odkaz' })).toHaveCount(0)

    const origin = await page.evaluate(() => window.location.origin)
    const stored = (await hostView(host, cycle.id)).link
    await expect(dialog.getByTestId('guest-link-url')).toHaveText(`${origin}/g/${stored.token}`)
  })

  test('loading: a centered `.sub` "Načítavam..." and no body state underneath it', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('loading')
    const cycle = await makeCycle('loading')
    await shareLink(host, cycle.id)

    await page.setViewportSize({ width: 378, height: 900 })
    await signInAsHost(page, host)
    // Hold the dialog's own GET open. Only the GET — the POST shares the URL.
    await page.route(`**/api/guest-links/cycle/${cycle.id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    })

    await gotoPortal(page)
    await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()

    const dialog = page.getByRole('dialog')
    const loading = dialog.locator('.m-body > .sub')
    await expect(loading).toHaveText('Načítavam...')
    expect(await loading.evaluate((el) => getComputedStyle(el).textAlign)).toBe('center')
    await expect(dialog.locator('.copyrow'), 'nothing renders under the spinner').toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Vytvoriť odkaz' })).toHaveCount(0)

    // …and it resolves into the link state.
    await expect(dialog.locator('.copyrow')).toHaveCount(1, { timeout: 10000 })
    await expect(dialog.locator('.m-body > .sub')).toHaveCount(0)
  })

  test('error: the `.banner.danger.slim` is the FIRST body child, and carries the server message', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('err')
    const cycle = await makeCycle('err')

    await page.setViewportSize({ width: 378, height: 900 })
    await signInAsHost(page, host)
    await page.route(`**/api/guest-links/cycle/${cycle.id}`, (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Odkaz sa nepodarilo načítať.' }),
      })
    })

    await gotoPortal(page)
    await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()

    const dialog = page.getByRole('dialog')
    const banner = dialog.locator('.banner.danger.slim')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Odkaz sa nepodarilo načítať.')
    // RD-KG-1's shape, reused rather than re-invented: `span.dot` + a min-width:0
    // block so a long server sentence cannot push the modal sideways.
    await expect(banner.locator('span.dot')).toHaveCount(1)
    expect(await banner.locator('div').first().evaluate((el) => el.style.minWidth)).toBe('0px')
    // FIRST child of the body in every state — a failure must never read as
    // "no link yet", which is the state rendered right under it.
    expect(await dialog.locator('.m-body > *').first().evaluate((el) => el.className)).toContain('banner')
    await expect(dialog.getByRole('button', { name: 'Vytvoriť odkaz' })).toBeVisible()
  })

  test('link exists: copy row, both ghost actions, no warn banner — and the testid sits on `.val`', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('exists')
    const cycle = await makeCycle('exists')
    const link = await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)

    const val = dialog.getByTestId('guest-link-url')
    const origin = await page.evaluate(() => window.location.origin)
    await expect(val).toHaveText(`${origin}/g/${link.token}`)
    // ⚠ The testid must sit on the VALUE node, not on the row — otherwise a text
    // assertion swallows the copy button's label (approved UC-DS-011 extension).
    expect(await val.evaluate((el) => el.className)).toBe('val')
    expect(await val.textContent(), 'the row label must not be inside the hook').not.toContain('Kopírovať')
    await expect(val).toHaveAttribute('title', `${origin}/g/${link.token}`)

    await expect(dialog.locator('.banner.warn'), 'an active link warns about nothing').toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Kopírovať' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Deaktivovať odkaz' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Vygenerovať nový odkaz' })).toBeVisible()
    await expect(dialog.locator('.confirmbox')).toHaveCount(0)
  })

  test('the copy button flips green "Skopírované!" for 2 s, and the clipboard gets the FULL url', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await refreshAdminToken()
    const host = await makeHost('copy')
    const cycle = await makeCycle('copy')
    const link = await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)
    const btn = dialog.locator('.copyrow button')
    await expect(btn).toHaveText('Kopírovať')

    await btn.click()
    await expect(btn).toHaveText('Skopírované!')
    expect(await btn.evaluate((el) => el.className)).toContain('ok')
    const origin = await page.evaluate(() => window.location.origin)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/g/${link.token}`)
    await expect(btn).toHaveText('Kopírovať', { timeout: 5000 })
  })

  test('deactivated: the warn banner appears, the label flips — and reactivating is the SAME button', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('deact')
    const cycle = await makeCycle('deact')
    const link = await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)
    await dialog.getByRole('button', { name: 'Deaktivovať odkaz' }).click()

    const warn = dialog.locator('.banner.warn.slim')
    await expect(warn).toBeVisible()
    await expect(warn.locator('span.dot')).toHaveCount(1)
    await expect(warn).toContainText('Odkaz je deaktivovaný')
    // ⚠ The bold lead and the sentence that follows must not be split by Vue's
    // `condense`, which deletes a newline-bearing whitespace node between them.
    await expect(warn).toContainText('Odkaz je deaktivovaný — kolegovia si cez neho nemôžu objednať.')
    await expect(warn.locator('b')).toHaveText('Odkaz je deaktivovaný')
    // The URL stays on screen: the host may still want to copy it.
    await expect(dialog.getByTestId('guest-link-url')).toContainText(`/g/${link.token}`)
    expect((await hostView(host, cycle.id)).link.active).toBe(0)

    // Deactivation is REVERSIBLE — the same control toggles back.
    await expect(dialog.getByRole('button', { name: 'Deaktivovať odkaz' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Znova aktivovať' }).click()
    await expect(dialog.locator('.banner.warn')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Deaktivovať odkaz' })).toBeVisible()
    const after = (await hostView(host, cycle.id)).link
    expect(after.active).toBe(1)
    expect(after.token, 'PATCH reactivation must not rotate the token').toBe(link.token)
  })

  test('the regenerate confirmbox: exact copy, "Zrušiť" backs out — and a real sub-order SURVIVES', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('regen')
    const cycle = await makeCycle('regen')
    const product = await addProduct(cycle.id, { name: `KG2 Brazil ${uniq}`, purpose: 'Espresso', price_250g: 7.6 })
    const link = await shareLink(host, cycle.id)
    const sub = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])

    const dialog = await openFromOrderPage(page, host, cycle)
    const trigger = dialog.getByRole('button', { name: 'Vygenerovať nový odkaz' })
    await trigger.click()

    const box = dialog.locator('.confirmbox')
    await expect(box).toBeVisible()
    // ⚠ The promise about the colleagues' orders is factual and MUST NOT be
    // softened: the server UPDATEs the token on the existing row, never
    // DELETE+INSERT, so every sub-order hanging off `link_id` survives.
    // ⚠ The space after the bold lead is asserted deliberately: Vue's `condense`
    // deletes a newline-bearing whitespace node between elements, which would
    // render "…fungovať.Objednávky…".
    await expect(box).toContainText('Starý odkaz prestane fungovať. Objednávky, ktoré vám kolegovia už poslali, zostanú zachované.')
    await expect(box.locator('b')).toHaveText('Starý odkaz prestane fungovať.')
    await expect(box.getByRole('button', { name: 'Áno, vygenerovať' })).toBeVisible()
    await expect(box.getByRole('button', { name: 'Zrušiť' })).toBeVisible()
    await expect(trigger, 'the trigger yields to its own confirmation').toHaveCount(0)

    // "Zrušiť" backs out with nothing written.
    await box.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(dialog.locator('.confirmbox')).toHaveCount(0)
    await expect(trigger).toBeVisible()
    expect((await hostView(host, cycle.id)).link.token, 'backing out rotates nothing').toBe(link.token)

    // And through.
    await trigger.click()
    await dialog.getByRole('button', { name: 'Áno, vygenerovať' }).click()
    await expect(dialog.getByTestId('guest-link-url')).not.toHaveText(new RegExp(`/g/${link.token}$`))
    await expect(dialog.locator('.confirmbox'), 'success closes the confirmbox').toHaveCount(0)

    const view = await hostView(host, cycle.id)
    expect(view.link.id, 'same row — the FKs stay valid').toBe(link.id)
    expect(view.link.token).not.toBe(link.token)
    const origin = await page.evaluate(() => window.location.origin)
    await expect(dialog.getByTestId('guest-link-url')).toHaveText(`${origin}/g/${view.link.token}`)

    // THE POINT of the copy: the colleague's order is still there, intact.
    expect(view.guest_orders.map((o) => o.id)).toContain(sub.order.id)
    const kept = view.guest_orders.find((o) => o.id === sub.order.id)
    expect(kept.status).toBe('submitted')
    expect(kept.items.length).toBe(1)
    expect(kept.total).toBe(sub.order.total)
  })
})

// ---------------------------------------------------------------------------
// UC-KG-006 — the native share conditional (resolved conflict 3)

test.describe('UC-KG-006 — native share', () => {
  test('without navigator.share the button is ABSENT, not relabeled', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('nonative')
    const cycle = await makeCycle('nonative')
    await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)
    await expect(dialog.locator('.copyrow')).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: 'Zdieľať' })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Zdieľať odkaz' })).toHaveCount(0)
    // The only accent-block button in this state would have been the share sheet.
    await expect(dialog.locator('.btn.accent.block')).toHaveCount(0)
  })

  test('with navigator.share the accent block button appears and hands over the FROZEN payload', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('native')
    const cycle = await makeCycle('native')
    const link = await shareLink(host, cycle.id)

    await page.setViewportSize({ width: 378, height: 900 })
    await signInAsHost(page, host)
    // `canNativeShare` is read once at setup(), so the stub has to exist before
    // the app boots — an init script, not an evaluate.
    await page.addInitScript(() => {
      window.__shared = []
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: (data) => { window.__shared.push(data); return Promise.resolve() },
      })
    })

    await gotoPortal(page)
    await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
    const dialog = page.getByRole('dialog')

    const share = dialog.getByRole('button', { name: 'Zdieľať odkaz' })
    await expect(share).toBeVisible()
    expect(await share.evaluate((el) => el.className)).toContain('accent')
    expect(await share.evaluate((el) => el.className)).toContain('block')
    await expect(share.locator('svg'), 'the prototype ships an icon with it').toHaveCount(1)

    await share.click()
    const origin = await page.evaluate(() => window.location.origin)
    // ⚠ FROZEN by decision: `document.title` is still "Gorifi - Objednávky"
    // (pinned by public-flow.spec.js), so the share sheet must not introduce the
    // app as something else in a message that links to a tab called Gorifi.
    expect(await page.evaluate(() => window.__shared)).toEqual([{
      title: 'Objednávka Gorifi',
      text: `Pridajte sa k mojej objednávke — ${cycle.name}`,
      url: `${origin}/g/${link.token}`,
    }])
  })
})

// ---------------------------------------------------------------------------
// UC-KG-007 — the mount seam, the loadSeq reset, order_token, 320px

test.describe('UC-KG-007 — mount seam and invariants', () => {
  // ⚠ THE REGRESSION THIS TEST EXISTS FOR. `guest-host-view.spec.js:890,929` use
  // an UNSCOPED `getByRole('button', { name: /Zdieľať/ })`; that spec is immutable
  // and is NOT among RD-KG-2's two authorized edits. A dialog left mounted while
  // closed contributes its own "Zdieľať odkaz" to that locator, and their
  // `toBeHidden()` / `toHaveCount(0)` become strict-mode violations.
  test('a CLOSED dialog contributes no button to the unscoped /Zdieľať/ locator', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('seam')
    const cycle = await makeCycle('seam')
    const product = await addProduct(cycle.id, { name: `KG2 Seam ${uniq}`, purpose: 'Espresso', price_250g: 7.6 })
    const link = await shareLink(host, cycle.id)
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signInAsHost(page, host)
    await gotoCycle(page, cycle)

    const share = page.getByRole('button', { name: /Zdieľať/ })
    // Exactly the calls guest-host-view.spec.js:890,929 make, in the same order
    // and with the same (unscoped) locator. The panel is `v-show`, so on the own
    // tab the button is `display:none` — out of the accessibility tree, hence
    // count 0 rather than "1, hidden". A dialog left mounted while closed would
    // be genuinely VISIBLE (NeoModal has no hidden state), which is exactly what
    // breaks `toBeHidden()` here and turns `toBeVisible()` below into a
    // strict-mode violation.
    await expect(share, 'own tab: the share card must not occupy the ordering screen').toBeHidden()
    await expect(share).toHaveCount(0)
    await page.getByTestId('main-tab-guests').click()
    await expect(share).toBeVisible()
    await expect(share, 'the guests tab offers exactly ONE share affordance').toHaveCount(1)
    await expect(page.locator('.modal-layer'), 'and no dialog is mounted yet').toHaveCount(0)

    // A locked cycle: count 0, still with nothing mounted.
    await setCycleStatus(cycle.id, 'locked')
    await gotoCycle(page, cycle)
    await page.getByTestId('main-tab-guests').click()
    await expect(page.getByTestId('guest-sub-orders')).toBeVisible()
    await expect(page.getByRole('button', { name: /Zdieľať/ })).toHaveCount(0)
    await expect(page.locator('.modal-layer')).toHaveCount(0)
  })

  test('reopening for another cycle re-loads: the previous cycle\'s link never flashes', async ({ page }) => {
    // The companion to guest-link.spec.js's delayed-GET race, from the other
    // side: the `open` watcher CLEARS state on close, so the second open starts
    // from nothing rather than from cycle A's link.
    await refreshAdminToken()
    const host = await makeHost('reset')
    const cycleA = await makeCycle('resetA')
    const cycleB = await makeCycle('resetB')
    const linkA = await shareLink(host, cycleA.id)

    await page.setViewportSize({ width: 378, height: 900 })
    await signInAsHost(page, host)
    await gotoPortal(page)

    await portalCard(page, cycleA.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
    await expect(page.getByTestId('guest-link-url')).toContainText(`/g/${linkA.token}`)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Cycle B has no link at all — so a leaked `link.value` would show up as
    // cycle A's URL where the "not created yet" sentence belongs.
    await portalCard(page, cycleB.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(cycleB.name)
    await expect(dialog.locator('p.sub')).toHaveText('Odkaz ešte nie je vytvorený.')
    await expect(dialog.getByTestId('guest-link-url')).toHaveCount(0)
    await expect(dialog.locator('.copyrow')).toHaveCount(0)
  })

  test('a guest\'s order_token reaches neither the host payload nor the DOM', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('token')
    const cycle = await makeCycle('token')
    const product = await addProduct(cycle.id, { name: `KG2 Token ${uniq}`, purpose: 'Espresso', price_250g: 7.6 })
    const link = await shareLink(host, cycle.id)
    const sub = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect(sub.order.order_token, 'the guest DOES get one').toBeTruthy()

    const view = await hostView(host, cycle.id)
    expect(JSON.stringify(view)).not.toContain(sub.order.order_token)
    expect(JSON.stringify(view)).not.toContain('order_token')

    const dialog = await openFromOrderPage(page, host, cycle)
    await expect(dialog.locator('.copyrow')).toHaveCount(1)
    // The host's URL is the LINK token; the guest's private edit token is nowhere.
    await expect(dialog.getByTestId('guest-link-url')).toContainText(`/g/${link.token}`)
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    expect(html).not.toContain(sub.order.order_token)
  })

  test('320px: no horizontal overflow in any state, and no control is clipped by the modal', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('narrow')
    const cycle = await makeCycle('narrow')
    await shareLink(host, cycle.id)

    // With `navigator.share` stubbed so the widest state — copy row + accent
    // block button + both ghost actions + the confirmbox — is the one measured.
    await page.setViewportSize({ width: 320, height: 900 })
    await signInAsHost(page, host)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: () => Promise.resolve() })
    })
    await gotoPortal(page)
    await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.copyrow')).toHaveCount(1)

    // ⚠ `.btn` is `white-space:nowrap`, so a too-wide control gives NO
    // degradation signal — it neither wraps nor ellipsizes, it pushes sideways.
    // Measuring min-content against the modal's own box is the only honest check.
    const clipped = () => dialog.evaluate((modal) => {
      const box = modal.getBoundingClientRect()
      const label = (el) => `${el.className}:${(el.textContent || '').trim().slice(0, 24)}`
      const bad = []
      // Nothing may extend past the modal's own box…
      for (const el of modal.querySelectorAll('.btn, .copyrow, .copyrow .val, .confirmbox, .banner')) {
        const r = el.getBoundingClientRect()
        if (r.right > box.right + 0.5 || r.left < box.left - 0.5) bad.push(label(el))
      }
      // …and no BUTTON may be narrower than its own min-content. (`.copyrow .val`
      // is deliberately excluded: `text-overflow:ellipsis` means its scrollWidth
      // exceeding clientWidth is the DESIGNED behaviour for a long URL.)
      for (const el of modal.querySelectorAll('.btn')) {
        if (el.scrollWidth > el.clientWidth + 1) bad.push(`min-content:${label(el)}`)
      }
      return bad
    })

    expect(await overflow(page)).toEqual({ scrollW: 320, clientW: 320 })
    expect(await clipped()).toEqual([])

    // Deactivated (the warn banner is the tallest extra node)…
    await dialog.getByRole('button', { name: 'Deaktivovať odkaz' }).click()
    await expect(dialog.locator('.banner.warn')).toBeVisible()
    expect(await overflow(page)).toEqual({ scrollW: 320, clientW: 320 })
    expect(await clipped()).toEqual([])

    // …and with the confirmbox open, whose `.row` does NOT wrap.
    await dialog.getByRole('button', { name: 'Vygenerovať nový odkaz' }).click()
    await expect(dialog.locator('.confirmbox')).toBeVisible()
    expect(await overflow(page)).toEqual({ scrollW: 320, clientW: 320 })
    expect(await clipped()).toEqual([])
  })

  // Module 02's permanent rule, re-asserted for this surface: the friends theme
  // never reaches an admin screen.
  test('no share-dialog theme class reaches an admin page', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)

    await refreshAdminToken()
    const cycles = await (await admin('/api/cycles')).json()
    const cycleId = cycles[0].id
    for (const path of ['/admin/dashboard', `/admin/cycle/${cycleId}`, `/admin/cycle/${cycleId}/distribution`]) {
      await page.goto(path)
      await page.waitForTimeout(400)
      const leaked = await page.evaluate(() => {
        const bad = ['.modal-layer', '.modal', '.m-body', '.copyrow', '.confirmbox', '.banner', '.btn.accent']
        return bad.filter((sel) => document.querySelector(sel) !== null)
      })
      expect(leaked, `${path} → ${JSON.stringify(leaked)}`).toEqual([])
    }
  })
})
