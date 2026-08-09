import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'

// RD-FL-6 — the profile modal on `NeoModal` (03 §UC-FL-009), and the scrim-drag
// amendment to 02 §UC-DS-010 that this row was the trigger for.
//
// ⚠ HERMETIC, per `portal-appbar.spec.js`: every test provisions what it needs
// over the admin API and signs the browser in by seeding a REAL session token
// into `localStorage.gorifi_friend_auth`. Nothing global is written; the shared
// seed stays legacy (the ONE test that needs the modern login card stubs
// `GET /friends/auth-mode` per page, RD-FL-2's idiom).
//
// ⚠ Any test that MUTATES the friend — renames them, changes their password —
// gets its OWN friend. `PUT /friends/:id/change-password` calls
// `invalidateFriendSessions`, so a shared friend would have its seeded token
// pulled out from under every later test in the file.

const TIMEOUT = 20_000
const PASSWORD = 'ownPass12'

let ctx = null
let adminToken = ''
/** Read-only friend, shared by the tests that do not mutate anything. */
let friend = null

function uniq() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
}

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

/**
 * A friend with a username, a known personal password and NO forced-change
 * flag — i.e. `hasCredentials: true`, which is what the password fold is keyed
 * on. The admin can only set a password via `reset-password`, which always
 * raises `must_change_password`, so the flag is cleared the way a real friend
 * clears it: one login + one change.
 */
async function makeFriend(label) {
  const u = uniq()
  const name = `RDFL6 ${label} ${u}`
  const username = `rdfl6${label}${u}`.toLowerCase().slice(0, 30)

  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const first = (await auth.json()).token

  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${first}` },
    data: { currentPassword: 'initPass1', newPassword: PASSWORD },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'clear forced change').toBe(200)
  const token = (await changed.json()).token

  const profile = await ctx.get(`/api/friends/${row.id}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT,
  })
  expect(profile.status(), 'friend profile').toBe(200)
  const full = await profile.json()
  expect(full.uid, 'the read-only ID box renders the uid').toBeTruthy()
  expect(full.hasCredentials, 'the fold is keyed on hasCredentials').toBe(true)

  return { id: row.id, name, username, uid: full.uid, token, password: PASSWORD }
}

/**
 * A friend with NO personal credentials — `hasCredentials: false`, which is what
 * transition mode auto-raises the credential-setup dialog on. They log in with
 * the shared password + the name dropdown.
 */
async function makePlainFriend(label) {
  const name = `RDFL6 ${label} ${uniq()}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  return { id: (await created.json()).id, name }
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
  friend = await makeFriend('ro')
})

test.afterAll(async () => { await ctx?.dispose() })

/**
 * ⚠ Kill the UC-FL-007 colleague-count storm.
 *
 * The cycle list fires ONE fire-and-forget `GET /api/guest-links/cycle/:id` per
 * OPEN cycle, and a full-suite database accumulates well over a hundred of them
 * (135 when this was measured). A test that logs in TWICE in one page therefore
 * queues a few hundred XHRs behind the browser's 6-connection limit, and the
 * second login's own `/friends/cycles` + `/vouchers/pending` calls starve behind
 * them — the button sits on "Overujem…" past the expect timeout. It passes in
 * isolation and fails in a full run, which is the worst possible flake.
 *
 * The counts are decoration whose fetch is already error-swallowing (see
 * `loadGuestCounts`), so dropping them changes nothing this file asserts.
 */
async function muteGuestCounts(page) {
  await page.route('**/api/guest-links/cycle/*', (route) => route.abort())
}

/** Sign the browser in the way "remember me" does. */
async function signIn(page, who = friend) {
  const stored = JSON.stringify({
    friendId: who.id,
    friendName: who.name,
    friendUid: who.uid,
    token: who.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, stored)
}

async function openPortal(page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
}

/**
 * Open the profile modal and return its locator.
 *
 * The appbar `.titles` block is the trigger (UC-FL-004). `hydrateCurrentFriend`
 * is fire-and-forget, so wait for the username box — the one field that only
 * exists once the profile GET has landed — before touching anything.
 */
async function openProfile(page, { hydrated = true } = {}) {
  await page.locator('.appbar .titles').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.m-title')).toHaveText('Upraviť profil')
  if (hydrated) await expect(dialog.getByTestId('profile-username')).toBeVisible()
  return dialog
}

/** Serve a profile with no username and no credentials (a legacy friend). */
async function stubLegacyProfile(page, who = friend) {
  await page.route('**/api/friends/*/profile', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: who.id, name: who.name, uid: who.uid, packeta_address: null }),
    })
  })
}

// ---------------------------------------------------------------------------

test.describe('Profile modal — structure on NeoModal (UC-FL-009)', () => {
  test('renders the prototype shell: title, read-only row, fields, fold, footer', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)

    // It is the NeoModal shell, not the old radix dialog.
    await expect(dialog).toHaveClass(/\bmodal\b/)
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog.locator('.m-x')).toHaveCount(1) // closable ⇒ × present
    await expect(page.locator('.modal-layer')).toHaveCount(1)

    // ⚠ Two read-only value boxes in the prototype's `.copyrow > .val` STYLE
    // and explicitly WITHOUT a copy button — this is not NeoCopyRow.
    const boxes = dialog.locator('.copyrow')
    await expect(boxes).toHaveCount(2)
    await expect(boxes.locator('button')).toHaveCount(0)
    await expect(dialog.getByTestId('profile-uid')).toHaveText(friend.uid)
    await expect(dialog.getByTestId('profile-username')).toHaveText(friend.username)
    await expect(dialog.getByTestId('profile-uid')).toHaveClass(/\bval\b/)

    // The old helper texts under the read-only row are DROPPED (UC-FL-009).
    await expect(dialog).not.toContainText('Toto ID sa nedá zmeniť')

    // The pair sits in one `display:flex; gap:10px` row (portal.jsx:178).
    const row = await dialog.getByTestId('profile-uid').evaluate((el) => {
      const s = getComputedStyle(el.parentElement.parentElement.parentElement)
      return { display: s.display, gap: s.columnGap }
    })
    expect(row, JSON.stringify(row)).toEqual({ display: 'flex', gap: '10px' })

    // Two editable fields with their verbatim help texts.
    await expect(dialog.locator('#pp-profile-name')).toHaveClass(/\binp\b/)
    await expect(dialog.locator('#pp-profile-packeta')).toHaveAttribute('placeholder', 'napr. Z-BOX Hlavná 15, Bratislava')
    await expect(dialog.locator('.field-help').nth(0)).toHaveText('Toto meno vidí správca a kolegovia.')
    await expect(dialog.locator('.field-help').nth(1)).toHaveText('Predvolená adresa pre doručenie Packetou (voliteľné).')

    // The fold's separator: 2px ink-at-12% rule with 12px of air under it.
    const fold = dialog.getByRole('button', { name: 'Zmeniť heslo' })
    const sep = await fold.evaluate((el) => {
      const s = getComputedStyle(el.parentElement)
      return { w: s.borderTopWidth, c: s.borderTopColor, p: s.paddingTop }
    })
    expect(sep, JSON.stringify(sep)).toEqual({ w: '2px', c: 'rgba(10, 10, 10, 0.12)', p: '12px' })
    await expect(fold).toHaveClass(/\bghost\b/)

    // Footer: Zrušiť + accent Uložiť, both stretched by `.m-foot .btn{flex:1}`.
    const foot = dialog.locator('.m-foot .btn')
    await expect(foot).toHaveCount(2)
    await expect(foot.nth(0)).toHaveText('Zrušiť')
    await expect(foot.nth(1)).toHaveText('Uložiť')
    await expect(foot.nth(1)).toHaveClass(/\baccent\b/)
    const widths = await foot.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)))
    expect(widths[0], JSON.stringify(widths)).toBe(widths[1])
  })

  test('⚠ every field resolves by its label (programmatic association)', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)

    // The read-only boxes are `div`s, which `<label for>` cannot address at
    // all — they carry `aria-labelledby` instead, and getByLabel must still
    // resolve them.
    await expect(dialog.getByLabel('Jedinečné ID')).toHaveText(friend.uid)
    await expect(dialog.getByLabel('Užívateľské meno')).toHaveText(friend.username)

    await expect(dialog.getByLabel('Prihlasovacie meno *')).toHaveValue(friend.name)
    await expect(dialog.getByLabel('Adresa Packeta výdajného miesta')).toHaveValue('')

    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()
    await expect(dialog.getByLabel('Aktuálne heslo')).toHaveAttribute('type', 'password')
    // ⚠ RD-FL-2's strict-mode trap: 'Nové heslo' substring-matches 'Potvrdiť
    // nové heslo', so both anchors are regexes.
    await expect(dialog.getByLabel(/^nové heslo$/i)).toHaveAttribute('type', 'password')
    await expect(dialog.getByLabel(/^potvrdiť nové heslo$/i)).toHaveAttribute('type', 'password')
  })

  test('the username box renders ONLY when the friend has one', async ({ page }) => {
    await signIn(page)
    await stubLegacyProfile(page)
    await openPortal(page)
    const dialog = await openProfile(page, { hydrated: false })

    await expect(dialog.getByTestId('profile-uid')).toHaveText(friend.uid)
    await expect(dialog.getByTestId('profile-username')).toHaveCount(0)
    await expect(dialog.locator('.copyrow')).toHaveCount(1)
  })

  test('the password fold renders ONLY for credentialed friends', async ({ page }) => {
    await signIn(page)
    await stubLegacyProfile(page)
    await openPortal(page)
    const dialog = await openProfile(page, { hydrated: false })

    await expect(dialog.getByRole('button', { name: 'Zmeniť heslo' })).toHaveCount(0)
    // …while the editable fields are all still there.
    await expect(dialog.getByLabel('Prihlasovacie meno *')).toBeVisible()
  })

  test('the fold toggles, and its label flips', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)

    await expect(dialog.getByLabel('Aktuálne heslo')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()

    await expect(dialog.getByLabel('Aktuálne heslo')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Skryť zmenu hesla' })).toHaveCount(1)
    // ⚠ Open, "Zmeniť heslo" belongs to the SUBMIT button alone — the toggle
    // has renamed itself, so the query stays unambiguous under strict mode.
    const submit = dialog.getByRole('button', { name: 'Zmeniť heslo' })
    await expect(submit).toHaveCount(1)
    await expect(submit).toHaveClass(/\bdark\b/)
    await expect(submit).toBeDisabled() // nothing filled in yet

    await dialog.getByRole('button', { name: 'Skryť zmenu hesla' }).click()
    await expect(dialog.getByLabel('Aktuálne heslo')).toHaveCount(0)
  })

  test('no horizontal overflow at 320px with the modal open', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()
    await expect(dialog.getByLabel('Aktuálne heslo')).toBeVisible()

    const m = await page.evaluate(() => {
      const modal = document.querySelector('.modal')
      const r = modal.getBoundingClientRect()
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        modalLeft: r.left,
        modalRight: r.right,
      }
    })
    expect(m.scrollWidth, JSON.stringify(m)).toBeLessThanOrEqual(m.clientWidth)
    expect(m.modalLeft, JSON.stringify(m)).toBeGreaterThanOrEqual(0)
    expect(m.modalRight, JSON.stringify(m)).toBeLessThanOrEqual(m.clientWidth)
  })
})

// ---------------------------------------------------------------------------

test.describe('saveProfile side-effects (unchanged behavior, new surface)', () => {
  test('⚠ saving a new name updates the appbar IMMEDIATELY and rewrites localStorage', async ({ page }) => {
    const who = await makeFriend('save')
    await signIn(page, who)
    await openPortal(page)
    await expect(page.locator('.appbar .titles .t')).toHaveText(who.name)

    const dialog = await openProfile(page)
    const renamed = `${who.name} R`
    await dialog.getByLabel('Prihlasovacie meno *').fill(renamed)
    await dialog.getByRole('button', { name: 'Uložiť' }).click()

    // No reload anywhere: the appbar name is RD-FL-3's `getCurrentFriendName()`
    // reading `currentFriend`, which `saveProfile` patches in place.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.appbar .titles .t')).toHaveText(renamed)

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gorifi_friend_auth')))
    expect(stored.friendName).toBe(renamed)

    // …and it really persisted: reopening prefills from the server value.
    const again = await openProfile(page)
    await expect(again.getByLabel('Prihlasovacie meno *')).toHaveValue(renamed)
  })

  test('⚠ a blank Packeta address is sent as null, not ""', async ({ page }) => {
    await signIn(page)
    await openPortal(page)

    const bodies = []
    await page.route('**/api/friends/*/profile', async (route) => {
      if (route.request().method() === 'PATCH') bodies.push(route.request().postDataJSON())
      await route.continue()
    })

    const dialog = await openProfile(page)
    await dialog.getByLabel('Adresa Packeta výdajného miesta').fill('   ')
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    expect(bodies.length, JSON.stringify(bodies)).toBe(1)
    expect(bodies[0]).toEqual({ name: friend.name, packeta_address: null })
  })

  test('"Uložiť" is disabled while the required name is blank', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)

    await dialog.getByLabel('Prihlasovacie meno *').fill('   ')
    await expect(dialog.getByRole('button', { name: 'Uložiť' })).toBeDisabled()
    await dialog.getByLabel('Prihlasovacie meno *').fill(friend.name)
    await expect(dialog.getByRole('button', { name: 'Uložiť' })).toBeEnabled()
  })

  test('⚠ a failed save renders .banner.danger.slim IN THE MODAL — and exactly once', async ({ page }) => {
    await signIn(page)
    await page.route('**/api/friends/*/profile', async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue()
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Profil sa nepodarilo uložiť' }),
      })
    })
    await openPortal(page)
    const dialog = await openProfile(page)

    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(dialog.locator('.banner.danger.slim')).toHaveText('Profil sa nepodarilo uložiť')

    // ⚠ ONE surface at a time: `.banner.danger` is never ambiguous and never a
    // visible duplicate.
    await expect(page.locator('.banner.danger')).toHaveCount(1)

    // ⚠ RE-POINTED by RD-FL-8a item 4, which mandates: "Give the profile modal a
    // `profileError` and the subscription modal a `subError`, after which
    // `error && !showProfileModal` collapses to `error`."
    //
    // RD-FL-6 satisfied "one surface at a time" by SUPPRESSING the page banner
    // while this modal was open and rendering the shared page-level `error` in
    // its body — so closing handed the same message back to the page banner.
    // That mechanism is gone: the message is now the modal's OWN `profileError`,
    // and the suppression term (which had to grow by one clause per dialog, and
    // let any other writer put a message in this modal's banner) with it.
    //
    // Same property, re-pointed at the mandated structure: the failure belongs
    // to THIS action and to nothing else. It is scoped to the modal, so it goes
    // when the modal does — and it can never reach the page banner, whose only
    // remaining writer is `resolveVoucher`.
    await dialog.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.banner.danger')).toHaveCount(0)
    await expect(page.locator('.app')).not.toContainText('Profil sa nepodarilo uložiť')

    // …and a retry starts clean: re-opening must not show the previous
    // attempt's message (the "a retry must not leave the previous attempt's
    // banner standing" rule, applied at the opener).
    const reopened = await openProfile(page)
    await expect(reopened.locator('.banner.danger.slim')).toHaveCount(0)
  })

  test('⚠ another writer\'s error must not open INSIDE the profile modal', async ({ page }) => {
    // ⚠ RE-POINTED (RD-FL-8a item 4; mandated by `PROGRESS.md` RD-FL-8a item (4)
    // "Converge the THREE-WAY `error` strategy", building on UC-FL-011's
    // dedicated `inviteError` from RD-FL-7). Cited per 03 §UC-FL-013's
    // reformulated e2e-immutability rule, case (a).
    //
    // The ORIGINAL mechanism is gone, and with it the original assertions'
    // meaning. This test used to work because `error` was page-level and shared
    // with `openInviteModal`, the profile modal rendered that shared ref as its
    // own `.banner.danger.slim`, and `openProfileModal` cleared it. After item 4
    // every action owns its ref and no opener clears anything, so the old body
    // passed VACUOUSLY: `.banner.danger` matched the invite modal's OWN banner
    // and vanished on Escape with the dialog, and the profile modal was
    // trivially clean because nothing could have written to it.
    //
    // The property is unchanged and still worth pinning — one action's failure
    // must never surface as another's — so it is now asserted STRUCTURALLY:
    // confinement by construction rather than by a clear-on-open.
    await signIn(page)
    await page.route('**/api/invitations/my-code*', (route) =>
      route.fulfill({ status: 500, json: { error: 'Pozvánku sa nepodarilo načítať' } })
    )
    await openPortal(page)

    // Fail an unrelated action: the "Pozvať" chip's invite-code fetch.
    await page.getByRole('button', { name: /Pozvať/ }).click()

    // 1. The failure is CONFINED to the invite dialog — it is that dialog's own
    //    `inviteError`, not a page-level banner sitting behind the scrim.
    const invite = page.getByRole('dialog')
    await expect(invite.locator('.banner.danger')).toContainText('Pozvánku sa nepodarilo načítať')
    const pageBanners = page.locator('.app > .banner.danger, .app > * > .banner.danger')
    await expect(pageBanners).toHaveCount(0)

    // 2. It dies with its own dialog; nothing outlives it to leak elsewhere.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.banner.danger')).toHaveCount(0)

    // 3. The profile modal therefore opens clean — and, unlike before, NOT
    //    because opening it wiped a shared message.
    const dialog = await openProfile(page)
    await expect(dialog.locator('.banner.danger.slim')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.banner.danger')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------

test.describe('changePassword (unchanged behavior, new surface)', () => {
  test('the length + mismatch validation messages are verbatim, in .banner.danger.slim', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()

    const submit = dialog.getByRole('button', { name: 'Zmeniť heslo' })
    const banner = dialog.locator('.banner.danger.slim')

    // The submit is disabled until all three are filled, so each message is
    // reached by filling all three and making exactly one of them wrong.
    // (The first message, "Zadajte aktuálne heslo", has its own test — it is
    // only reachable through the Enter shortcut.)
    await dialog.getByLabel('Aktuálne heslo').fill(PASSWORD)
    await dialog.getByLabel(/^nové heslo$/i).fill('short1')
    await dialog.getByLabel(/^potvrdiť nové heslo$/i).fill('short1')
    await submit.click()
    await expect(banner).toHaveText('Nové heslo musí mať aspoň 8 znakov')

    // 3. mismatch
    await dialog.getByLabel(/^nové heslo$/i).fill('longEnough1')
    await dialog.getByLabel(/^potvrdiť nové heslo$/i).fill('longEnough2')
    await submit.click()
    await expect(banner).toHaveText('Nové heslá sa nezhodujú')
  })

  test('⚠ "Zadajte aktuálne heslo" — reached through Enter, which bypasses the disabled button', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()

    // The submit button is disabled while the current password is empty, so
    // this message is unreachable through it. `@keyup.enter` on the CONFIRM
    // field calls `changePassword()` directly and has no such guard — which is
    // exactly the path the message exists for, and why it must stay.
    await dialog.getByLabel(/^nové heslo$/i).fill('longEnough1')
    await dialog.getByLabel(/^potvrdiť nové heslo$/i).fill('longEnough1')
    await expect(dialog.getByRole('button', { name: 'Zmeniť heslo' })).toBeDisabled()

    await dialog.getByLabel(/^potvrdiť nové heslo$/i).press('Enter')
    await expect(dialog.locator('.banner.danger.slim')).toHaveText('Zadajte aktuálne heslo')
  })

  test('a wrong current password shows the SERVER error inside the fold', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()

    await dialog.getByLabel('Aktuálne heslo').fill('definitelyWrong1')
    await dialog.getByLabel(/^nové heslo$/i).fill('longEnough1')
    await dialog.getByLabel(/^potvrdiť nové heslo$/i).fill('longEnough1')
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()

    await expect(dialog.locator('.banner.danger.slim')).toHaveText('Aktuálne heslo nie je správne')
    // The page-level banner is NOT a writer here — this error never leaves the fold.
    await expect(page.locator('.banner.danger:not(.slim)')).toHaveCount(0)
  })

  test('⚠ success: .banner.ok.slim, verbatim copy, 3s auto-hide, token rotated', async ({ page }) => {
    // Own friend: a successful change invalidates every session of that friend.
    const who = await makeFriend('pw')
    await signIn(page, who)
    await openPortal(page)
    const dialog = await openProfile(page)
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()

    await dialog.getByLabel('Aktuálne heslo').fill(who.password)
    await dialog.getByLabel(/^nové heslo$/i).fill('brandNew12345')
    // Enter in the CONFIRM field submits (UC-FL-009).
    await dialog.getByLabel(/^potvrdiť nové heslo$/i).fill('brandNew12345')
    await dialog.getByLabel(/^potvrdiť nové heslo$/i).press('Enter')

    const ok = dialog.locator('.banner.ok.slim')
    await expect(ok).toHaveText('Heslo bolo úspešne zmenené')
    // Green, not the danger red — 02's semantic colour grammar.
    await expect(ok).toHaveCSS('background-color', 'rgb(223, 242, 232)')

    // The fields are cleared on success…
    await expect(dialog.getByLabel('Aktuálne heslo')).toHaveValue('')
    await expect(dialog.getByLabel(/^nové heslo$/i)).toHaveValue('')

    // …the token rotated into localStorage (and no plaintext password left)…
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gorifi_friend_auth')))
    expect(stored.token, 'a NEW session token').not.toBe(who.token)
    expect(stored.token).toBeTruthy()
    expect(stored.password).toBeUndefined()

    // …and the banner auto-hides after 3s.
    await expect(ok).toHaveCount(0, { timeout: 8_000 })

    // The rotated token really works: the modal is still live against the API.
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.banner.danger')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------

test.describe('⚠ NeoModal scrim-drag — the UC-DS-010 amendment (RD-DS-4 → RD-FL-6)', () => {
  test('a text-selection drag out of .m-body must NOT close the modal', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)

    // Something worth losing.
    const sentinel = 'Half-typed value'
    await dialog.getByLabel('Prihlasovacie meno *').fill(sentinel)

    // Press on TEXT inside the body (the help line under the name field),
    // drag out over the scrim, release. The `click` that follows is delivered
    // on the nearest common ancestor — `.modal-scrim` — which is exactly what
    // `@click.self` used to accept.
    const help = dialog.locator('.field-help').first()
    const from = await help.boundingBox()
    await page.mouse.move(from.x + 5, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(6, 6, { steps: 12 })
    await page.mouse.up()

    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Prihlasovacie meno *')).toHaveValue(sentinel)
  })

  test('a genuine scrim click still closes it', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)

    // Press AND release on the scrim, away from the card.
    await page.mouse.move(6, 6)
    await page.mouse.down()
    await page.mouse.up()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // …as do Esc and the ×, unchanged.
    await openProfile(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const again = await openProfile(page)
    await again.locator('.m-x').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('⚠ a non-primary press on the scrim must not LATCH the close permission', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)

    // A right-click on the scrim correctly does not close…
    await page.mouse.move(6, 6)
    await page.mouse.down({ button: 'right' })
    await page.mouse.up({ button: 'right' })
    await expect(dialog).toBeVisible()

    // …and it must not have left the origin flag set either. It produces no
    // `click` to consume the flag (middle-click does not even produce one —
    // it fires `auxclick`), so without the `button === 0` test the very next
    // click to reach the scrim would inherit permission from a gesture that
    // was never a dismissal. Script-reachable only, but the one-shot rule the
    // handler documents has to actually hold.
    await page.evaluate(() => document.querySelector('.modal-scrim').click())
    await expect(dialog).toBeVisible()

    await page.mouse.down({ button: 'middle' })
    await page.mouse.up({ button: 'middle' })
    await page.evaluate(() => document.querySelector('.modal-scrim').click())
    await expect(dialog).toBeVisible()
  })

  test('⚠ the origin listener runs in the CAPTURE phase', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)
    const sentinel = 'Half-typed value'
    await dialog.getByLabel('Prihlasovacie meno *').fill(sentinel)

    await page.evaluate(() => {
      // A descendant that swallows `mousedown`. Nothing in `frontend/src` does
      // this today, but this is the shared shell modules 04–06 fill with
      // checkout / pickup / payment / guest-identity content, third-party
      // components included — and bubble-phase, one such listener leaves the
      // origin flag at the PREVIOUS gesture's value, re-opening the exact
      // hazard the UC-DS-010 amendment closes.
      document.querySelector('.m-body').addEventListener('mousedown', (e) => e.stopPropagation())
      // Latch the flag with a press the browser answers with no `click` —
      // which is what a press on a classic scrollbar does (see below).
      document
        .querySelector('.modal-scrim')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })

    const help = dialog.locator('.field-help').first()
    const from = await help.boundingBox()
    await page.mouse.move(from.x + 5, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(6, 6, { steps: 12 })
    await page.mouse.up()

    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Prihlasovacie meno *')).toHaveValue(sentinel)
  })

  test('a drag that starts on the scrim and ends inside the card does not need to be special-cased', async ({ page }) => {
    // Recorded for the next reader: the amendment constrains the mousedown
    // ORIGIN only. A press that starts on the backdrop is already an intent to
    // dismiss, so releasing over the card still closes — pre-existing behavior,
    // deliberately untouched.
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)
    const card = await dialog.boundingBox()

    await page.mouse.move(6, 6)
    await page.mouse.down()
    await page.mouse.move(card.x + card.width / 2, card.y + 8, { steps: 8 })
    await page.mouse.up()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  // ⚠ NOT A TEST, and deliberately so — the scrim SCROLLBAR question, measured
  // and closed during the RD-FL-6 review.
  //
  // `.modal-scrim` is `overflow-y:auto`, so on a short viewport it scrolls, and
  // the worry was that dragging a CLASSIC (layout-consuming) scrollbar is a
  // press + release + click all targeting the scrim itself — which the origin
  // check accepts, so the modal would close while the user was only scrolling.
  //
  // It cannot be reproduced in this suite because Playwright launches headless
  // Chromium with `--hide-scrollbars`, so the scrim never grows one (measured:
  // `scrollHeight 476 > clientHeight 300` yet `offsetWidth === clientWidth`).
  // Launching Chromium with `ignoreDefaultArgs: ['--hide-scrollbars']` at
  // 420×300 DOES produce a real 15px classic scrollbar, and with it:
  //   · a thumb drag, a track click, a thumb click and an arrow click each
  //     deliver `mousedown` + `mouseup` on `.modal-scrim` (`self: true`,
  //     `button: 0`, `offsetX: 413` vs `clientWidth: 405`) and **no `click` at
  //     all** — the modal stays open every time (and the scrim scrolls);
  //   · the follow-up text-selection drag out of `.m-body` still does not close
  //     it, because that drag's own mousedown re-computes the flag.
  // So the hazard is not real in Chromium, and an `offsetX < clientWidth` guard
  // would be dead code. Recorded here rather than guarded. The only residue is
  // that a scrollbar press leaves the flag set for a later *programmatic*
  // `click()` — the same script-only class as the non-primary press above.
})

// ---------------------------------------------------------------------------

test.describe('⚠ session-scoped modal state dies with the session', () => {
  test('the fold, its fields and its messages do not survive a logout', async ({ page }) => {
    // ⚠ NO RELOAD: a remount re-inits every ref regardless and would make this
    // pass against the very bug it exists for. The logout and the re-login
    // happen in ONE component instance, which needs the MODERN login card —
    // stubbed per page, RD-FL-2's idiom. The seed stays legacy.
    const who = await makeFriend('sess')
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'modern' } }))
    await muteGuestCounts(page)
    await signIn(page, who)
    await openPortal(page)

    const dialog = await openProfile(page)
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()
    // A plaintext password in a field, and a message naming this session.
    await dialog.getByLabel('Aktuálne heslo').fill('mySecretPass1')
    await dialog.getByLabel(/^nové heslo$/i).fill('short1')
    await dialog.getByLabel(/^potvrdiť nové heslo$/i).fill('short1')
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()
    await expect(dialog.locator('.banner.danger.slim')).toHaveText('Nové heslo musí mať aspoň 8 znakov')
    await dialog.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Log out…
    await page.locator('.appbar span[aria-label="Odhlásiť sa"]').click()
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')

    // …and back in through the form. On a shared device this is routinely a
    // DIFFERENT person, who must not be handed the previous one's password.
    await page.getByLabel(/^užívateľské meno$/i).fill(who.username)
    await page.getByLabel(/^heslo$/i).fill(who.password)
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()

    const reopened = await openProfile(page)
    // Fold closed again (UC-FL-009 specifies default-closed)…
    await expect(reopened.getByRole('button', { name: 'Zmeniť heslo' })).toHaveCount(1)
    await expect(reopened.getByLabel('Aktuálne heslo')).toHaveCount(0)
    // …no message from the previous session…
    await expect(reopened.locator('.banner.danger.slim')).toHaveCount(0)
    // …and no credential left in the fields.
    await reopened.getByRole('button', { name: 'Zmeniť heslo' }).click()
    await expect(reopened.getByLabel('Aktuálne heslo')).toHaveValue('')
    await expect(reopened.getByLabel(/^nové heslo$/i)).toHaveValue('')
    await expect(reopened.getByLabel(/^potvrdiť nové heslo$/i)).toHaveValue('')
  })

  test('⚠ the CREDENTIAL-SETUP dialog must not open pre-filled with the previous friend\'s credentials', async ({ page }) => {
    // The second plaintext credential this component held across a logout, and
    // the worse of the two: `authenticate()` re-raises `showCredentialSetup` for
    // ANY transition-mode friend without personal credentials, so the next
    // person does not have to open anything — the dialog renders itself, with
    // the previous person's username and password already in it, and "Nastaviť"
    // would write that password onto the new account.
    //
    // ⚠ NO RELOAD, same as the test above: both logins happen in ONE component
    // instance. Transition mode is stubbed per page (the shared seed stays
    // legacy) and the login list is stubbed down to these two friends, so the
    // name dropdown is a two-option list.
    const a = await makePlainFriend('leakA')
    const b = await makePlainFriend('leakB')
    const leaked = `LEAKED-SECRET-${uniq()}`

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
    await page.addInitScript(() => localStorage.clear())

    /**
     * Shared-password login, and wait for the credential-setup dialog it raises.
     * ⚠ Do NOT wait for the cycle-list heading here: this is a radix dialog, so
     * it `aria-hidden`s the rest of the page and `getByRole` (which reads the
     * accessibility tree) cannot see anything behind it.
     */
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
    // ⚠ `getByText('Prihlásenie')` is ambiguous here — transition mode also
    // renders the "Osobné prihlásenie" tab.
    await expect(page.getByRole('heading', { name: 'Prihlásenie' })).toBeVisible()
    // Friend A gets the auto-raised setup dialog, types a username and a
    // password, trips one validation message, then dismisses with "Neskôr" —
    // i.e. every ref stays exactly as typed, because `saveCredentials()` clears
    // them on its SUCCESS path only.
    const setup = await sharedLogin(a)
    await setup.getByPlaceholder('napr. janko_hrasko').fill(`rdfl6leak${uniq()}`)
    await setup.getByPlaceholder('Minimálne 4 znaky').fill(leaked)
    await setup.getByPlaceholder('Zopakujte heslo').fill(`${leaked}x`)
    await setup.getByRole('button', { name: 'Nastaviť', exact: true }).click()
    await expect(setup.getByText('Heslá sa nezhodujú')).toBeVisible()
    await setup.getByRole('button', { name: 'Neskôr' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()

    // Log out, and let a DIFFERENT friend log in with the same shared password.
    await page.locator('.appbar span[aria-label="Odhlásiť sa"]').click()
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')

    // B's dialog opens by itself — that is the whole point — and it must be blank.
    const reopened = await sharedLogin(b)
    await expect(reopened.getByPlaceholder('napr. janko_hrasko')).toHaveValue('')
    await expect(reopened.getByPlaceholder('Minimálne 4 znaky')).toHaveValue('')
    await expect(reopened.getByPlaceholder('Zopakujte heslo')).toHaveValue('')
    await expect(reopened).not.toContainText('Heslá sa nezhodujú')
    // Belt and braces: A's password must not survive anywhere in the DOM.
    expect(await page.content()).not.toContain(leaked)
  })
})

// ---------------------------------------------------------------------------

test.describe('Admin invariance', () => {
  test('no theme/neo classes leak onto an admin page', async ({ page }) => {
    await page.goto('/admin')
    const leaked = await page.evaluate(() => {
      const bad = ['.app', '.modal-layer', '.field-lbl', '.copyrow', '.banner', '.appbar']
      return bad.filter((sel) => document.querySelector(sel) !== null)
    })
    expect(leaked, JSON.stringify(leaked)).toEqual([])
  })
})
