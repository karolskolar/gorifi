import { test, expect, request as playwrightRequest } from '@playwright/test'
// PI-T1 · 18 §UC-PI-019 item 1 — the ONE home of the „portal is ready“ gate.
// It replaces this file's `getByRole('heading', { name: 'Objednávkové cykly' })`
// waits: that heading is a STRUCTURE module 18 retires (§UC-PI-005), so a gate
// tied to its copy could not survive the screen. Same claim, one home.
import { ackExplainer, expectLanding, logout, menuGo, openProfile as portalOpenProfile, expectChromeName } from '../helpers/portal.js'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'
import { collectAppCopy } from '../helpers/copy-sweep.js'
import { makeAdmin } from '../helpers/admin.js'

// FUP-T20's source-grep guard needs the checkout's own path (see that test).
const HERE = dirname(fileURLToPath(import.meta.url))

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
 * A friend with a username, a known personal password and NO forced-change
 * flag — i.e. `hasCredentials: true`, which is what the password fold is keyed
 * on. The admin can only set a password via `reset-password`, which always
 * raises `must_change_password`, so the flag is cleared the way a real friend
 * clears it: one login + one change.
 */
/**
 * ⚠ 18 §UC-PI-015 (PI-T10) — the fixture phone, and it is not decoration.
 *
 * „Mobil *" is REQUIRED from this row on: „Uložiť" is disabled while it is blank, and
 * the profile modal AUTO-OPENS on a login for a friend whose stored phone is empty.
 * Every fixture below that saves the form, or that wants a quiet screen, therefore
 * provisions a phone. The tests that need an EMPTY one say so at the site and create
 * their own friend — see the auto-open describe.
 */
const FIXTURE_PHONE = '0900 111 222'

async function makeFriend(label, { phone = FIXTURE_PHONE, ack = true } = {}) {
  const u = uniq()
  const name = `RDFL6 ${label} ${u}`
  const username = `rdfl6${label}${u}`.toLowerCase().slice(0, 30)

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
    data: { currentPassword: 'initPass1', newPassword: PASSWORD },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'clear forced change').toBe(200)
  const token = (await changed.json()).token

  // ⚠ 18 §UC-PI-013 (PI-T9): a friend created here has never acknowledged „Ako to
  // funguje", so a LOGIN THROUGH THE CARD would land on `/ako-to-funguje` — where the
  // hamburger is a back chevron, so every drawer helper below times out. One round
  // trip through the real route; see `helpers/portal.js ackExplainer`.
  // ⚠ `ack: false` is the PI-T10 explainer-precedence fixture: a friend who has not
  // acknowledged „Ako to funguje" is a FIRST-login friend, which is the one state in
  // which §UC-PI-013's gate and §UC-PI-015's auto-open compete for the same login.
  if (ack) await ackExplainer(ctx, { id: row.id, token })

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
async function makePlainFriend(label, { phone = FIXTURE_PHONE } = {}) {
  const name = `RDFL6 ${label} ${uniq()}`
  // ⚠ 18 §UC-PI-015 (PI-T10) — a phone, for the same reason `makeFriend` has one: both
  // callers of this helper log in THROUGH THE CARD, and a phone-less login auto-opens
  // the profile modal. A test counting dialogs would then be counting that.
  const created = await admin('/api/friends', { method: 'post', data: { name, phone } })
  expect(created.status(), 'friend create').toBe(201)
  const id = (await created.json()).id

  // ⚠ 18 §UC-PI-013 (PI-T9): these two log in THROUGH THE CARD, so an unacknowledged
  // friend lands on `/ako-to-funguje` — a view whose appbar carries a back chevron
  // instead of the hamburger, which is what `logout()` reaches for below. They have no
  // credentials of their own, so the session `ackExplainer` needs comes from the
  // LEGACY shared-password branch of `POST /friends/auth`, the one login that mints a
  // token for a credential-less friend.
  const auth = await ctx.post('/api/friends/auth', {
    data: { password: FRIENDS_PASSWORD, friendId: id },
    timeout: TIMEOUT,
  })
  expect(auth.status(), 'legacy shared-password session for a credential-less friend').toBe(200)
  await ackExplainer(ctx, { id, token: (await auth.json()).token })

  return { id, name, phone }
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
  await expectLanding(page)
}

/**
 * Open the profile modal and return its locator.
 *
 * ⚠ RETARGETED BY PI-T2 (18 §UC-PI-019 item 5, case (a)). The trigger used to be
 * the appbar `.titles` block (03 §UC-FL-004); §UC-PI-003 strips `.titles` of its
 * role, tabindex, aria-label and handler in EVERY state and moves the profile into
 * the drawer, so the trigger is now the „Profil" menu row — `portalOpenProfile()`
 * from `helpers/portal.js`, the one home. The PROTECTED PROPERTY is untouched:
 * `hydrateCurrentFriend` is still fire-and-forget, so this still waits for the
 * username box — the one field that only exists once the profile GET has landed —
 * before anything touches the form.
 */
async function openProfile(page, { hydrated = true } = {}) {
  await portalOpenProfile(page)
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

    // ⚠ RETARGETED (e2e-immutability case (a)) — FUP-T20 removes the
    // `Jedinečné ID` box: an internal identifier with nothing a friend can act
    // on. ONE read-only value box survives (the username), still in the
    // prototype's `.copyrow > .val` STYLE and still explicitly WITHOUT a copy
    // button — this is not NeoCopyRow. The count went 2 → 1 rather than being
    // dropped, because the "no copy button" and "it is a `.val` box" halves are
    // the properties this assertion exists for.
    const boxes = dialog.locator('.copyrow')
    await expect(boxes).toHaveCount(1)
    await expect(boxes.locator('button')).toHaveCount(0)
    await expect(dialog.getByTestId('profile-username')).toHaveText(friend.username)
    await expect(dialog.getByTestId('profile-username')).toHaveClass(/\bval\b/)
    // FUP-T20: the uid box is gone, on a hydrated modal too.
    await expect(dialog.getByTestId('profile-uid')).toHaveCount(0)
    await expect(dialog).not.toContainText('Jedinečné ID')

    // The old helper texts under the read-only row are DROPPED (UC-FL-009).
    await expect(dialog).not.toContainText('Toto ID sa nedá zmeniť')

    // The read-only row is still the `display:flex; gap:10px` row (portal.jsx:178)
    // — kept as the row it always was, now holding one box. RETARGETED off
    // `profile-uid` (FUP-T20); the nesting it walks is identical.
    const row = await dialog.getByTestId('profile-username').evaluate((el) => {
      const s = getComputedStyle(el.parentElement.parentElement.parentElement)
      return { display: s.display, gap: s.columnGap }
    })
    expect(row, JSON.stringify(row)).toEqual({ display: 'flex', gap: '10px' })

    // Two editable fields with their verbatim help texts.
    // ⚠ RETARGETED (case (a)) — FUP-T20: the name field's help text no longer
    // says "Toto meno vidí správca a kolegovia." alone; it names the reason the
    // field is REQUIRED, which is Packeta delivery.
    await expect(dialog.locator('#pp-profile-name')).toHaveClass(/\binp\b/)
    await expect(dialog.locator('#pp-profile-packeta')).toHaveAttribute('placeholder', 'napr. Z-BOX Hlavná 15, Bratislava')

    // ⚠ RETARGETED (case (a)) — 18 §UC-PI-019 item 10 / §UC-PI-015's field table.
    // The two `.field-help` pins were nth(0)=Meno, nth(1)=Packeta; §19 reorders the
    // body (Login → Meno → Mobil → E-mail → Packeta) and gives Login, Mobil and
    // E-mail helps of their own. The PROTECTED PROPERTY is „the help texts are
    // verbatim AND in the documented order", so the assertion grows into the whole
    // sequence rather than being re-pointed at two of five — an nth() pin that does
    // not cover the tail cannot see a field that moved past it.
    await expect(dialog.locator('.field-help')).toHaveCount(5)
    await expect(dialog.locator('.field-help').nth(0)).toHaveText('Meno, ktorým sa prihlasujete. Nemení sa.')
    await expect(dialog.locator('.field-help').nth(1)).toHaveText('Celé meno. Uvádza sa na zásielke pri doručení Packetou a vidí ho správca aj kolegovia.')
    await expect(dialog.locator('.field-help').nth(2)).toHaveText('Pre koordináciu objednávky a odovzdanie.')
    await expect(dialog.locator('.field-help').nth(3)).toHaveText('Voliteľné. Packeta naň posiela informácie o zásielke; slúži aj na obnovenie prístupu.')
    await expect(dialog.locator('.field-help').nth(4)).toHaveText('Predvolená adresa pre doručenie Packetou (voliteľné).')
    // The help the E-mail row REPLACES (§UC-PI-015 row 4) is really gone.
    await expect(dialog).not.toContainText('Bez e-mailu vám nevieme poslať odkaz na obnovenie prístupu.')

    // …and the INPUTS are in the same order as their helps. `.field-help` alone
    // cannot see a field that moved without its help; this is the other half.
    const fieldIds = await dialog.locator('.m-body input.inp').evaluateAll((els) => els.map((e) => e.id))
    expect(fieldIds, JSON.stringify(fieldIds))
      .toEqual(['pp-profile-name', 'pp-profile-phone', 'pp-profile-email', 'pp-profile-packeta'])

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

    // The read-only box is a `div`, which `<label for>` cannot address at
    // all — it carries `aria-labelledby` instead, and getByLabel must still
    // resolve it.
    // ⚠ RETARGETED (case (a), FUP-T20): `Jedinečné ID` is removed, so its
    // getByLabel pin becomes the absence assertion. The property this test
    // exists for — programmatic label association on a non-input — is still
    // asserted, on the box that survives.
    await expect(dialog.getByLabel('Jedinečné ID')).toHaveCount(0)
    // ⚠ RETARGETED (case (a)) — 18 §UC-PI-019 item 10: the read-only row's label is
    // „Login" since PI-T10 (§UC-PI-015 row 1). The property this line exists for —
    // programmatic label association on a NON-INPUT, which `<label for>` cannot do —
    // is untouched; only the string moved.
    await expect(dialog.getByLabel('Login')).toHaveText(friend.username)
    // ⚠ NON-VACUITY, and it is the half that makes the rename real: „Užívateľské meno"
    // survives on the LOGIN SCREEN (03 §UC-FL-002) and in both username-SETUP dialogs
    // in this same component, so the rename is only observable as an absence INSIDE
    // this dialog. `getByLabel` substring-matches, so this also proves no setup label
    // is currently rendered here to collide with it.
    await expect(dialog.getByLabel('Užívateľské meno')).toHaveCount(0)

    // ⚠ RETARGETED (case (a), FUP-T20): the label was `Prihlasovacie meno *`
    // while the field writes `friends.name`. Same field, truthful label.
    await expect(dialog.getByLabel('Meno a priezvisko *')).toHaveValue(friend.name)
    // ⚠ RETARGETED (case (a)) — §UC-PI-015 rows 3/4: „Mobil" gained its star and
    // „Email" became „E-mail" (a different string to a substring matcher).
    await expect(dialog.getByLabel('Mobil *')).toHaveValue(FIXTURE_PHONE)
    await expect(dialog.getByLabel('E-mail')).toHaveValue('')
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

    // ⚠ RETARGETED (case (a), FUP-T20): with the uid box removed, a legacy
    // friend has NO read-only box at all — which is the honest end state of
    // "renders ONLY when the friend has one". The editable fields below are
    // asserted still present by the next test, so this is not a blank modal.
    await expect(dialog.getByTestId('profile-uid')).toHaveCount(0)
    await expect(dialog.getByTestId('profile-username')).toHaveCount(0)
    await expect(dialog.locator('.copyrow')).toHaveCount(0)
    // Non-vacuity: the modal really did render (it is just the row that is empty).
    await expect(dialog.locator('#pp-profile-name')).toBeVisible()
  })

  test('the password fold renders ONLY for credentialed friends', async ({ page }) => {
    await signIn(page)
    await stubLegacyProfile(page)
    await openPortal(page)
    const dialog = await openProfile(page, { hydrated: false })

    await expect(dialog.getByRole('button', { name: 'Zmeniť heslo' })).toHaveCount(0)
    // …while the editable fields are all still there.
    await expect(dialog.getByLabel('Meno a priezvisko *')).toBeVisible()

    // ⚠ STILL ZERO AFTER GA-T11, and for a reason worth stating rather than
    // rediscovering. That row added a SECOND fold — "Nastaviť heslo", for a friend
    // whose `password_hash` is NULL — but it is gated on `hasCredentials === false`
    // AND modern mode, and this stub publishes NO `hasCredentials` at all. Absent is
    // not false (`!undefined` would be the bug), and this target is legacy. So the
    // property this test names is unchanged: an UNHYDRATED legacy modal offers no
    // password control of either kind.
    // ⚠ NOT WEAKENED AND NOT RETARGETED — the assertion above is the shipped one,
    // byte for byte; the line below only widens the claim it already made.
    await expect(dialog.getByRole('button', { name: /heslo/i })).toHaveCount(0)
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

  // FUP-T20 item 5. The row asks for the measurement to be taken rather than
  // assumed after a field left the modal, and for the STRICTER form of the
  // assertion (`scrollWidth - clientWidth === 0`, not `<=`) at BOTH widths, with
  // the fold closed and open. The `<=` test above stays as shipped.
  for (const width of [320, 390]) {
    test(`⚠ zero horizontal overflow at ${width}px, fold closed AND open`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 })
      await signIn(page)
      await openPortal(page)
      const dialog = await openProfile(page)

      const measure = () =>
        page.evaluate(() => {
          const d = document.documentElement
          const r = document.querySelector('.modal').getBoundingClientRect()
          return {
            overflow: d.scrollWidth - d.clientWidth,
            clientWidth: d.clientWidth,
            modalLeft: Math.round(r.left),
            modalRight: Math.round(r.right),
            modalWidth: Math.round(r.width),
          }
        })

      const closed = await measure()
      expect(closed.overflow, `fold closed: ${JSON.stringify(closed)}`).toBe(0)
      expect(closed.modalLeft, JSON.stringify(closed)).toBeGreaterThanOrEqual(0)
      expect(closed.modalRight, JSON.stringify(closed)).toBeLessThanOrEqual(closed.clientWidth)

      await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()
      await expect(dialog.getByLabel('Aktuálne heslo')).toBeVisible()
      const open = await measure()
      expect(open.overflow, `fold open: ${JSON.stringify(open)}`).toBe(0)
      expect(open.modalRight, JSON.stringify(open)).toBeLessThanOrEqual(open.clientWidth)
    })
  }
})

// ---------------------------------------------------------------------------

/**
 * FUP-T20 — the guard that let this bug survive, now MACHINE-CHECKED on the
 * friend surface too.
 *
 * 07 §UC-IA-007 / 11 §UC-FC-002 USED TO state the rule as `grep -i prihlasovac
 * frontend/src/views/AdminFriends.vue` returning nothing. That grep named ONE
 * file, and the identical label lived in `FriendPortalSession.vue` on a field
 * that writes the same `friends.name` column — so the admin half was fixed by
 * module 11 while the friend half shipped the same lie to staging.
 * ⚠ FUP-T21 widened BOTH specs (and 07's two "do not touch that view" bullets) to
 * the two-file form, so they no longer disagree with CLAUDE.md or with this file.
 *
 * The sweep is the `admin-friends-labels.spec.js` idiom (text AND the attributes
 * that render as copy), pointed at the friend portal with the profile modal open.
 * The property is an ABSENCE, because new copy alone would let a revert pass:
 * "Meno a priezvisko *" can be added while "Prihlasovacie meno" stays one row up.
 */
// ⚠ FUP-T22 — the collector used to be a byte copy of `admin-friends-labels.spec.js`'s.
// It now lives in `e2e/helpers/copy-sweep.js` (ONE home), and it drops every
// `[data-user-copy]` subtree, because a copy sweep asserts what the APP calls a field
// and a friend may be NAMED anything — the shipped template has a friend literally
// called `Prihlasovacie.meno`. Nothing on this surface is marked yet, so what this
// file reads is unchanged; mark the interpolation (never the app copy around it) if a
// person-supplied value ever lands inside a sweep here.

test.describe('⚠ FUP-T20 — no copy on the friend surface claims the name is a login', () => {
  /**
   * The guard AS IT IS WRITTEN, executed. §UC-FC-002 / 07 §UC-IA-007 state it as a
   * grep over source, and since FUP-T21 they name BOTH views, as CLAUDE.md does — so
   * this test runs that grep instead of trusting someone to. It is the half the DOM sweep below cannot
   * cover: a string in a dialog state no test happens to open is invisible to the
   * browser and plainly visible here.
   *
   * ⚠ Reads repo source, the `self-hosted-fonts.spec.js` precedent. It self-skips
   * when the checkout is not next to the suite (a BASE_URL run against staging from
   * elsewhere), so the file stays target-agnostic.
   */
  test('the grep guard itself: both views that edit `friends.name` are clean', () => {
    const views = [
      resolve(HERE, '../../frontend/src/views/AdminFriends.vue'),
      resolve(HERE, '../../frontend/src/views/FriendPortalSession.vue'),
    ]
    if (!views.every((p) => existsSync(p))) {
      test.skip(true, 'frontend source not available next to the suite')
      return
    }
    for (const path of views) {
      const hits = readFileSync(path, 'utf8')
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /prihlasovac/i.test(line))
      expect(hits, `${path} claims the name field is a login: ${JSON.stringify(hits)}`).toEqual([])
    }
    // Non-vacuity: the reader really works and the pattern really matches — the
    // same substring IS legitimately present where it labels `friends.username`.
    const invitations = resolve(HERE, '../../frontend/src/views/AdminInvitations.vue')
    if (existsSync(invitations)) {
      expect(readFileSync(invitations, 'utf8')).toMatch(/prihlasovac/i)
    }
  })

  test('the portal and the profile modal are free of /prihlasovac/i', async ({ page }) => {
    await signIn(page)
    await openPortal(page)

    const portalCopy = await page.evaluate(collectAppCopy())
    expect(portalCopy, 'the portal claims a login somewhere').not.toMatch(/prihlasovac/i)

    const dialog = await openProfile(page)
    const modalCopy = await page.evaluate(collectAppCopy())
    expect(modalCopy, 'the profile modal claims the name is a login').not.toMatch(/prihlasovac/i)

    // Non-vacuity: the sweep really does read this modal's copy.
    // ⚠ Case-INSENSITIVE: `.field-lbl` is `text-transform: uppercase` and
    // `innerText` applies text-transform, so these arrive as "MENO A PRIEZVISKO *"
    // (the standing CLAUDE.md trap). The absence assertions above are already
    // case-insensitive regexes, so they are unaffected.
    expect(modalCopy).toMatch(/meno a priezvisko \*/i)
    // ⚠ RETARGETED (case (a)) — 18 §UC-PI-015 row 1 renames THIS row's label to
    // „Login". The line is a NON-VACUITY anchor („the sweep really read the modal"),
    // not a claim about the string, so it follows the label. ⚠ The absence half above
    // is what the test is for and is untouched — and the new help line („Meno, ktorým
    // sa prihlasujete. Nemení sa.") is precisely the wording that keeps it green: a
    // VERB, never the guarded adjective.
    expect(modalCopy).toMatch(/\blogin\b/i)
    expect(modalCopy, 'the renamed row really replaced the old label').not.toMatch(/užívateľské meno/i)
    // …and the modal is the one that used to carry the claim, on the field that
    // writes `friends.name`.
    await expect(dialog.getByLabel('Meno a priezvisko *')).toHaveValue(friend.name)

    // The password fold is copy too, and it is the one place a login-ish string
    // would be legitimate — it must still avoid the guarded substring.
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()
    await expect(dialog.getByLabel('Aktuálne heslo')).toBeVisible()
    const foldCopy = await page.evaluate(collectAppCopy())
    expect(foldCopy, 'the password fold claims a login').not.toMatch(/prihlasovac/i)
    expect(foldCopy).toMatch(/aktuálne heslo/i)
  })
})

// ---------------------------------------------------------------------------

/**
 * FUP-T20 item 3 — `friends.display_name` is the ADMIN-ONLY note ("recommended
 * by X"). `GET /friends/:id/profile` did `SELECT *` and `sanitizeFriend` strips
 * only credential material, so the note was already in the friend's browser —
 * nothing rendered it, but it was one DevTools tab from visible.
 *
 * ⚠ Both halves matter. Stripping it in `sanitizeFriend` (7 call sites, several
 * admin) would pass the removal assertion while breaking the admin Poznámka
 * column, which reads `display_name` off the admin list. So the admin
 * counter-assertion is not decoration: it is what makes the fix a route-scoped
 * one rather than a central one.
 */
test.describe('⚠ FUP-T20 — the admin note never reaches the friend', () => {
  test('the friend profile omits display_name; the admin list still carries it', async () => {
    const who = await makeFriend('note')
    const note = `FUP-T20 odporucil kolega ${uniq()}`

    expect((await admin(`/api/friends/${who.id}`, { method: 'patch', data: { name: who.name, display_name: note } })).status(),
      'seed the admin note').toBe(200)

    // 1. The friend's own payload — asserted on the RAW BODY, not on parsed
    //    keys: a nested/renamed copy of the note is just as much a leak.
    const mine = await ctx.get(`/api/friends/${who.id}/profile`, {
      headers: { Authorization: `Bearer ${who.token}` },
      timeout: TIMEOUT,
    })
    expect(mine.status()).toBe(200)
    const raw = await mine.text()
    expect(raw, 'the friend payload names the admin-only column').not.toMatch(/display_name/)
    expect(raw, 'the friend payload carries the admin note VALUE').not.toContain(note)
    // Non-vacuity: this really is the profile payload and it is still useful.
    const parsed = JSON.parse(raw)
    expect(parsed.id).toBe(who.id)
    expect(parsed.name).toBe(who.name)
    expect(parsed.uid).toBeTruthy()
    expect(parsed.hasCredentials).toBe(true)
    // The credential strip is unchanged (the fix must not have moved it).
    expect(raw).not.toMatch(/password_hash|access_token|invite_code|google_sub/)

    // 2. THE COUNTER-ASSERTION. The admin Poznámka column reads `display_name`
    //    off `GET /api/friends` — the fix must not have touched it.
    const list = await admin('/api/friends')
    expect(list.status()).toBe(200)
    const row = (await list.json()).find((f) => f.id === who.id)
    expect(row, 'the friend is in the admin list').toBeTruthy()
    expect(row.display_name, 'the admin lost the Poznámka value').toBe(note)

    // …and the admin detail endpoint too (the friend edit modal's source).
    const detail = await admin(`/api/friends/${who.id}/detail`)
    expect(detail.status()).toBe(200)
    expect((await detail.json()).friend.display_name).toBe(note)
  })
})

// ---------------------------------------------------------------------------

test.describe('saveProfile side-effects (unchanged behavior, new surface)', () => {
  test('⚠ saving a new name updates the appbar IMMEDIATELY and rewrites localStorage', async ({ page }) => {
    const who = await makeFriend('save')
    await signIn(page, who)
    await openPortal(page)
    // ⚠ RETARGETED BY PI-T2 (18 §UC-PI-003, case (a)). `.appbar .titles .s` was the
    // friend's NAME from 2026-08-09 until this module; it is now a FIXED per-view
    // subtitle, and the name moved to the drawer header — the only place a friend's
    // identity renders now. The protected property is „saving a new name updates the
    // chrome IMMEDIATELY, with no reload", so the assertion follows the name into
    // the drawer instead of following the selector.
    await expectChromeName(page, who.name)

    const dialog = await openProfile(page)
    const renamed = `${who.name} R`
    await dialog.getByLabel('Meno a priezvisko *').fill(renamed)
    await dialog.getByRole('button', { name: 'Uložiť' }).click()

    // No reload anywhere: the appbar name is RD-FL-3's `getCurrentFriendName()`
    // reading `currentFriend`, which `saveProfile` patches in place.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // ⚠ Same retarget, the load-bearing half: the name the CHROME renders is the
    // drawer header's, and it followed the save with no reload in between.
    await expectChromeName(page, renamed)
    // The wordmark is not data and must NOT follow the rename — and neither does
    // the subtitle, which is now a fixed per-view string (§UC-PI-003).
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
    await expect(page.locator('.appbar .titles .s')).toHaveText('Aktuálna ponuka')
    await expect(page.locator('.appbar')).not.toContainText(renamed)

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gorifi_friend_auth')))
    expect(stored.friendName).toBe(renamed)

    // …and it really persisted: reopening prefills from the server value.
    const again = await openProfile(page)
    await expect(again.getByLabel('Meno a priezvisko *')).toHaveValue(renamed)
  })

  test('⚠ a blank Packeta address is sent as null, not ""', async ({ page }) => {
    // ⚠ FUP-T5 sanctioned edit — the ASSERTION is untouched, its SETUP is not.
    // `saveProfile` now sends `packeta_address` only when it CHANGED (FC-T4's
    // open-time-original delta, extended to this field so an unhydrated modal
    // cannot wipe a stored address). This test's intent is an INTENTIONALLY
    // CLEARED address travelling as `null` and never as `''`, so the clear has
    // to be a real change: it gets its own friend WITH an address stored. The
    // shared read-only `friend` has none — and must keep none, because the
    // label/prefill tests above assert that field opens empty.
    const who = await makeFriend('pkt')
    const stored = 'Z-BOX Testovacia 1, Bratislava'
    expect((await ctx.patch(`/api/friends/${who.id}/profile`, {
      headers: { Authorization: `Bearer ${who.token}` },
      data: { name: who.name, packeta_address: stored },
      timeout: TIMEOUT,
    })).status(), 'seed a stored Packeta address').toBe(200)

    await signIn(page, who)
    await openPortal(page)

    const bodies = []
    await page.route('**/api/friends/*/profile', async (route) => {
      if (route.request().method() === 'PATCH') bodies.push(route.request().postDataJSON())
      await route.continue()
    })

    const dialog = await openProfile(page)
    const packeta = dialog.getByLabel('Adresa Packeta výdajného miesta')
    // Non-vacuity: the stored address really is on screen, so blanking it is a
    // genuine clear and not an already-empty field.
    await expect(packeta).toHaveValue(stored)
    await packeta.fill('   ')
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    expect(bodies.length, JSON.stringify(bodies)).toBe(1)
    expect(bodies[0]).toEqual({ name: who.name, packeta_address: null })
  })

  // FUP-T5 — the bug this row exists for. `hydrateCurrentFriend` is
  // fire-and-forget, so the modal is openable BEFORE the profile GET lands; the
  // Packeta field then renders empty because `props.friend` has no
  // `packeta_address` yet. Sending it unconditionally turned that empty render
  // into a destructive `null` write.
  test('⚠ an unhydrated modal must NOT wipe a stored Packeta address', async ({ page }) => {
    const who = await makeFriend('unhyd')
    const stored = 'Z-BOX Nezmazateľná 7, Košice'
    expect((await ctx.patch(`/api/friends/${who.id}/profile`, {
      headers: { Authorization: `Bearer ${who.token}` },
      data: { name: who.name, packeta_address: stored },
      timeout: TIMEOUT,
    })).status(), 'seed a stored Packeta address').toBe(200)

    await signIn(page, who)

    // Stall hydration for the whole test: the GET never resolves, so the modal
    // opens on the pre-hydration state the bug needs. The PATCH on the same URL
    // pattern still goes through, and is what we inspect.
    const bodies = []
    await page.route('**/api/friends/*/profile', async (route) => {
      if (route.request().method() !== 'GET') {
        bodies.push(route.request().postDataJSON())
        return route.continue()
      }
      // Never fulfilled, never continued — hydration simply does not land.
    })

    await openPortal(page)
    const dialog = await openProfile(page, { hydrated: false })
    // Precondition of the bug: the field is empty because nothing hydrated it.
    await expect(dialog.getByLabel('Adresa Packeta výdajného miesta')).toHaveValue('')
    // The name still prefills — it comes from the stored session, not the GET.
    await expect(dialog.getByLabel('Meno a priezvisko *')).toHaveValue(who.name)

    // ⚠ RETARGETED (case (a)) — 18 §UC-PI-015 row 3 made „Mobil *" required, and
    // hydration is what would have prefilled it, so an unhydrated modal now opens
    // with „Uložiť" DISABLED. That is a real consequence of the row and it is pinned
    // here rather than left implied: before hydration lands, this form cannot be
    // saved at all until the friend types a phone.
    await expect(dialog.getByLabel('Mobil *')).toHaveValue('')
    await expect(dialog.getByRole('button', { name: 'Uložiť' })).toBeDisabled()
    await dialog.getByLabel('Mobil *').fill(FIXTURE_PHONE)

    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // On the wire: an untouched, unhydrated field is simply absent. ⚠ THE PROTECTED
    // PROPERTY IS THE ABSENCE OF `packeta_address`, not the exact key set — the phone
    // the friend just typed IS a change and travels, which is the delta rule working.
    expect(bodies.length, JSON.stringify(bodies)).toBe(1)
    expect(bodies[0]).toEqual({ name: who.name, phone: FIXTURE_PHONE })
    expect(bodies[0], 'an unhydrated Packeta field must not travel').not.toHaveProperty('packeta_address')

    // …and where it actually matters — the stored address survived the save.
    const after = await ctx.get(`/api/friends/${who.id}/profile`, {
      headers: { Authorization: `Bearer ${who.token}` },
      timeout: TIMEOUT,
    })
    expect(after.status()).toBe(200)
    expect((await after.json()).packeta_address, 'the stored address must survive').toBe(stored)
  })

  test('"Uložiť" is disabled while the required name is blank', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)

    await dialog.getByLabel('Meno a priezvisko *').fill('   ')
    await expect(dialog.getByRole('button', { name: 'Uložiť' })).toBeDisabled()
    await dialog.getByLabel('Meno a priezvisko *').fill(friend.name)
    await expect(dialog.getByRole('button', { name: 'Uložiť' })).toBeEnabled()
  })

  // 18 §UC-PI-015 row 3 (PI-T10) — the SECOND required field, and its client half.
  test('⚠ "Uložiť" is disabled while the required Mobil is blank — independently of the name', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)
    const save = dialog.getByRole('button', { name: 'Uložiť' })

    // Non-vacuity: the name is fine throughout, so only the phone can be the reason.
    await expect(dialog.getByLabel('Meno a priezvisko *')).toHaveValue(friend.name)
    await expect(save).toBeEnabled()

    await dialog.getByLabel('Mobil *').fill('   ')
    await expect(save, 'a whitespace-only phone is blank').toBeDisabled()
    await dialog.getByLabel('Mobil *').fill('')
    await expect(save).toBeDisabled()
    await dialog.getByLabel('Mobil *').fill('0900 999 888')
    await expect(save).toBeEnabled()
  })

  // ⚠ A `disabled` attribute does not stop a DISPATCHED click reaching the handler
  // (CLAUDE.md), so `saveProfile()` carries the same two terms in JS. Without the JS
  // half this dispatch would PATCH a blank phone and take the server's 400 into the
  // banner; with it, nothing leaves the page at all.
  test('⚠ a dispatched click on the disabled "Uložiť" sends no request', async ({ page }) => {
    await signIn(page)
    await openPortal(page)

    const bodies = []
    await page.route('**/api/friends/*/profile', async (route) => {
      if (route.request().method() === 'PATCH') bodies.push(route.request().postDataJSON())
      await route.continue()
    })

    const dialog = await openProfile(page)
    await dialog.getByLabel('Mobil *').fill('')
    await dialog.getByRole('button', { name: 'Uložiť' }).dispatchEvent('click')
    // The modal is still open (nothing succeeded) and no PATCH was made.
    await expect(dialog.locator('.m-title')).toHaveText('Upraviť profil')
    expect(bodies, JSON.stringify(bodies)).toEqual([])
    // Non-vacuity for the route interception itself: a real save DOES record one.
    await dialog.getByLabel('Mobil *').fill('0900 777 666')
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(bodies.length, JSON.stringify(bodies)).toBe(1)
  })

  // 18 §UC-PI-015 — the `maxlength` mirror (the GSO-T3 convention: every server bound
  // is an attribute in the UI). ⚠ `pp-profile-packeta`'s 160 is NEW with PI-T10 and is
  // the mirror of this row's new server rule.
  test('⚠ the field contract: types, placeholders and the maxlength mirror', async ({ page }) => {
    await signIn(page)
    await openPortal(page)
    const dialog = await openProfile(page)

    const phone = dialog.getByLabel('Mobil *')
    await expect(phone).toHaveAttribute('type', 'tel')
    await expect(phone).toHaveAttribute('maxlength', '32')
    await expect(phone).toHaveAttribute('placeholder', '+421 900 000 000')

    const email = dialog.getByLabel('E-mail')
    await expect(email).toHaveAttribute('type', 'email')
    await expect(email).toHaveAttribute('maxlength', '160')
    // NO placeholder on E-mail (the 2026-08-10 no-placeholder decision).
    await expect(email).not.toHaveAttribute('placeholder', /./)

    const packeta = dialog.getByLabel('Adresa Packeta výdajného miesta')
    await expect(packeta).toHaveAttribute('maxlength', '160')
    await expect(packeta).toHaveAttribute('placeholder', 'napr. Z-BOX Hlavná 15, Bratislava')

    // Name keeps its 120 (MAX_NAME_LENGTH), so the mirror is complete.
    await expect(dialog.getByLabel('Meno a priezvisko *')).toHaveAttribute('maxlength', '120')
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
    await dialog.getByLabel('Meno a priezvisko *').fill(sentinel)

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
    await expect(dialog.getByLabel('Meno a priezvisko *')).toHaveValue(sentinel)
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
    await dialog.getByLabel('Meno a priezvisko *').fill(sentinel)

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
    await expect(dialog.getByLabel('Meno a priezvisko *')).toHaveValue(sentinel)
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
    await logout(page)
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')

    // …and back in through the form. On a shared device this is routinely a
    // DIFFERENT person, who must not be handed the previous one's password.
    await page.getByLabel(/^užívateľské meno$/i).fill(who.username)
    await page.getByLabel(/^heslo$/i).fill(who.password)
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
    await expectLanding(page)

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
    await expectLanding(page)

    // Log out, and let a DIFFERENT friend log in with the same shared password.
    await logout(page)
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

// ---------------------------------------------------------------------------
// 18 §UC-PI-015 (PI-T10) — THE SERVER HALF: `PATCH /api/friends/:id/profile`
// ---------------------------------------------------------------------------

test.describe('⚠ PI-T10 — the profile route: Mobil required HERE ONLY, Packeta bounded at 160', () => {
  /** The friend's own PATCH, with their own session — the only identity this route takes. */
  function ownPatch(who, data) {
    return ctx.patch(`/api/friends/${who.id}/profile`, {
      headers: { Authorization: `Bearer ${who.token}` },
      data,
      timeout: TIMEOUT,
    })
  }

  async function readRow(who) {
    const res = await ctx.get(`/api/friends/${who.id}/profile`, {
      headers: { Authorization: `Bearer ${who.token}` },
      timeout: TIMEOUT,
    })
    expect(res.status()).toBe(200)
    return res.json()
  }

  test('a blank phone is 400 { field: "phone" } — and the row is unchanged', async () => {
    const who = await makeFriend('reqphone')
    expect((await readRow(who)).phone, 'fixture precondition').toBe(FIXTURE_PHONE)

    for (const blank of ['', '   ', null]) {
      const res = await ownPatch(who, { phone: blank })
      expect(res.status(), `phone=${JSON.stringify(blank)}`).toBe(400)
      expect(await res.json()).toEqual({ error: 'Zadajte mobilné číslo', field: 'phone' })
    }

    // ⚠ EVERY REFUSAL TEST READS THE ROW BACK: a 400 that wrote anyway is
    // indistinguishable from one that did not, from the status line alone.
    expect((await readRow(who)).phone).toBe(FIXTURE_PHONE)
  })

  test('⚠ the refusal is SCOPED to this route: the ADMIN PATCH may still clear a phone', async () => {
    const who = await makeFriend('adminclear')
    // The shared validator (`validateAdminFriendFields`) is the one both routes use,
    // so this is the assertion that the required rule did NOT go into it.
    const res = await admin(`/api/friends/${who.id}`, { method: 'patch', data: { phone: null } })
    expect(res.status(), 'the admin clears a phone').toBe(200)
    expect((await readRow(who)).phone, 'and it really cleared').toBeNull()
  })

  test('⚠ a whole PATCH is refused by a blank phone — the name beside it is not written', async () => {
    const who = await makeFriend('atomic')
    const res = await ownPatch(who, { name: `${who.name} NOPE`, phone: '' })
    expect(res.status()).toBe(400)
    expect((await res.json()).field).toBe('phone')
    const row = await readRow(who)
    expect(row.name, 'validation runs before any write').toBe(who.name)
    expect(row.phone).toBe(FIXTURE_PHONE)
  })

  test('an ABSENT phone is not a clear — a name-only PATCH still 200s', async () => {
    const who = await makeFriend('absent')
    const renamed = `${who.name} OK`
    expect((await ownPatch(who, { name: renamed })).status()).toBe(200)
    const row = await readRow(who)
    expect(row.name).toBe(renamed)
    expect(row.phone).toBe(FIXTURE_PHONE)
  })

  test('packeta_address: 160 passes, 161 is a 400 { field: "packeta_address" }, and the row is unchanged', async () => {
    const who = await makeFriend('pktbound')
    const ok = 'Z'.repeat(160)
    expect((await ownPatch(who, { packeta_address: ok })).status(), '160 is allowed').toBe(200)
    expect((await readRow(who)).packeta_address).toBe(ok)

    const res = await ownPatch(who, { packeta_address: 'Z'.repeat(161) })
    expect(res.status()).toBe(400)
    expect(await res.json()).toEqual({
      error: 'Adresa Packeta výdajného miesta je príliš dlhá (najviac 160 znakov)',
      field: 'packeta_address',
    })
    expect((await readRow(who)).packeta_address, 'the stored address survived the refusal').toBe(ok)

    // ⚠ The bound is on the TRIMMED value, like every other rule on this route.
    expect((await ownPatch(who, { packeta_address: `  ${ok}  ` })).status(), 'trimmed to 160').toBe(200)
  })

  test('⚠ FUP-T12 survives: a NON-STRING packeta_address is still treated as an absent key', async () => {
    const who = await makeFriend('pkt12')
    const stored = 'Z-BOX FUP12, Bratislava'
    expect((await ownPatch(who, { packeta_address: stored })).status()).toBe(200)

    // A number/object/array must not 500, must not wipe the stored address, and must
    // not be measured against the new length rule either.
    for (const bad of [123, {}, [], true]) {
      const res = await ownPatch(who, { name: who.name, packeta_address: bad })
      expect(res.status(), `packeta_address=${JSON.stringify(bad)}`).toBe(200)
    }
    expect((await readRow(who)).packeta_address, 'never wiped').toBe(stored)

    // `null` still CLEARS — the shipped convention the FUP-T12 comment protects.
    expect((await ownPatch(who, { packeta_address: null })).status()).toBe(200)
    expect((await readRow(who)).packeta_address).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 18 §UC-PI-015 + PO decision 2026-09-19 („Profile modal auto-open = YES") and
// orchestrator clarification (c) — THE AUTO-OPEN (PI-T10)
// ---------------------------------------------------------------------------
//
// The rule, in full: a friend whose STORED `phone` is empty meets the profile modal
// by itself, AFTER the forced-password gate, the Google prompt and PI-T9's explainer
// gate have resolved; it is dismissible PER SESSION and comes back at the NEXT LOGIN
// until Mobil is filled.
//
// ⚠⚠ „NEXT LOGIN", NOT „NEXT SESSION MOUNT", AND THE DIFFERENCE IS PINNED BELOW.
// `FriendPortal.vue` restores a stored session on EVERY document load, so a trigger
// that fired on the mount would put this modal in front of a phone-less friend on
// every reload and every deep link they open. §UC-PI-013 rejected exactly that for the
// explainer („must not be dragged into it by every reload, only by a fresh login") and
// `beginSession`'s `freshLogin` flag inherits the boundary verbatim: the three LOGIN
// paths pass it, neither restore path does. Both halves are asserted here — a login
// opens it, a reload of that same session does not.

test.describe('⚠ PI-T10 — the profile modal auto-opens until Mobil is filled', () => {
  const PROFILE_TITLE = 'Upraviť profil'

  /** A friend with a username and a known password, and NO stored phone. */
  function makePhonelessFriend(label) {
    return makeFriend(label, { phone: null })
  }

  /**
   * The MODERN login card — a real login, which is what arms the auto-open.
   * (`signIn()` above seeds `localStorage` instead: that is a RESTORE, and the tests
   * below rely on the two being different.)
   */
  async function cardLogin(page, who, { password = PASSWORD } = {}) {
    await muteGuestCounts(page)
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'modern' } }))
    await page.goto('/')
    await page.getByLabel(/^užívateľské meno$/i).fill(who.username)
    await page.getByLabel(/^heslo$/i).fill(password)
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
    await expectLanding(page)
  }

  test('a LOGIN by a friend with no stored phone opens it by itself', async ({ page }) => {
    const who = await makePhonelessFriend('auto')
    await cardLogin(page, who)

    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.m-title')).toHaveText(PROFILE_TITLE)
    // It is THE profile modal, opened on the field the rule exists for.
    await expect(dialog.getByLabel('Mobil *')).toHaveValue('')
    await expect(dialog.getByRole('button', { name: 'Uložiť' })).toBeDisabled()
    // ⚠ Nothing in this test opened the drawer — the modal arrived on its own.
    await expect(page.getByRole('dialog')).toHaveCount(1)
  })

  test('⚠ a friend WHO HAS a phone is never interrupted', async ({ page }) => {
    // The non-vacuity counterpart of the test above: same login, same screen, and the
    // only difference is the stored column.
    const who = await makeFriend('autoquiet')
    await cardLogin(page, who)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // …and it stays shut: the landing is genuinely interactive.
    await expect(page.getByTestId('portal-landing')).toBeVisible()
  })

  test('⚠ dismissing it is PER SESSION — it does not come back in the same session', async ({ page }) => {
    const who = await makePhonelessFriend('dismiss')
    await cardLogin(page, who)
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.m-title')).toHaveText(PROFILE_TITLE)
    await dialog.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Walking the portal in the same session must not re-raise it — the drawer is
    // reachable, which also proves nothing is left covering the appbar.
    await menuGo(page, 'Zostatok a platby')
    await expect(page).toHaveURL(/\/zostatok$/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await menuGo(page, 'Aktuálna ponuka')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('⚠ a RESTORE is not a login: a reload does NOT re-open it', async ({ page }) => {
    const who = await makePhonelessFriend('restore')
    await cardLogin(page, who)
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText(PROFILE_TITLE)
    await page.getByRole('dialog').getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The login wrote `gorifi_friend_auth`, so this reload restores the session —
    // the same path a deep link takes. ⚠ NO `signIn()` here: its `addInitScript`
    // clears localStorage on EVERY navigation, which would destroy the very session
    // this test is reloading (the PI-T4 trap).
    await page.reload()
    await expectLanding(page)
    await expect(page.getByRole('dialog'), 'a restore must not auto-open it').toHaveCount(0)
    // Non-vacuity: the phone really is still empty, so the only reason it stayed shut
    // is that a restore is not a login.
    const row = await ctx.get(`/api/friends/${who.id}/profile`, {
      headers: { Authorization: `Bearer ${who.token}` },
      timeout: TIMEOUT,
    })
    expect((await row.json()).phone).toBeNull()
  })

  test('⚠ it comes back at the NEXT login — and stops once Mobil is saved', async ({ page }) => {
    const who = await makePhonelessFriend('next')
    await cardLogin(page, who)
    await page.getByRole('dialog').getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Second login, same browser: still no phone, so it is there again.
    await logout(page)
    await page.getByLabel(/^užívateľské meno$/i).fill(who.username)
    await page.getByLabel(/^heslo$/i).fill(PASSWORD)
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
    await expectLanding(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.m-title')).toHaveText(PROFILE_TITLE)

    // Fill it in and save — the one thing that ends the prompt for good.
    await dialog.getByLabel('Mobil *').fill('0911 654 321')
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Third login: quiet.
    await logout(page)
    await page.getByLabel(/^užívateľské meno$/i).fill(who.username)
    await page.getByLabel(/^heslo$/i).fill(PASSWORD)
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
    await expectLanding(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  // ⚠⚠ PRECEDENCE. Unlike PI-T9's explainer (a VIEW, which a modal simply paints
  // over), this is a `NeoModal`: opened while the forced-password gate is up it would
  // STACK on a gate the friend cannot dismiss. Both halves are asserted in one
  // document — the gate is alone while it is up, and the profile modal arrives the
  // moment it is satisfied — because either half alone passes on the wrong build.
  test('⚠ it waits for the forced-password gate, and arrives when that gate clears', async ({ page }) => {
    const who = await makePhonelessFriend('gate')
    // An admin reset raises `must_change_password` — UC-FL-012's gate.
    expect((await admin(`/api/friends/${who.id}/reset-password`, { method: 'put', data: { password: 'tempPass2' } })).status()).toBe(200)

    await cardLogin(page, who, { password: 'tempPass2' })

    const gate = page.getByTestId('forced-password-change')
    await expect(gate).toBeVisible()
    // EXACTLY ONE dialog while the gate is up: the profile modal is not stacked on it.
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.locator('.modal-layer')).toHaveCount(1)
    await expect(page.getByRole('dialog')).not.toContainText(PROFILE_TITLE)

    // ⚠ RD-FL-2's strict-mode trap: 'Nové heslo' substring-matches 'Potvrdiť nové heslo'.
    await gate.getByLabel(/^nové heslo$/i).fill('friendChosen9')
    await gate.getByLabel(/^potvrdiť nové heslo$/i).fill('friendChosen9')
    await gate.getByRole('button', { name: /Nastaviť heslo a pokračovať/ }).click()
    await expect(gate).toBeHidden()

    // …and now it is this friend's turn to be asked for a phone.
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText(PROFILE_TITLE)
  })

  // ⚠⚠ THE FOURTH PRECEDENCE TERM, AND IT HAD NO TEST UNTIL A MUTATION SAID SO.
  // Removing `!explainerGate.value` from the trigger reddened NOTHING: every fixture in
  // `portal-explainer.spec.js` carries a phone, so the two rules never met. They meet on
  // exactly one friend — a FIRST login with no stored phone — and that is this test.
  // §UC-PI-013 owns that login: the explainer is a VIEW the friend must be shown, and a
  // modal over it would be the first thing they see instead.
  test('⚠ it waits for the FIRST-LOGIN explainer gate, and arrives when that gate clears', async ({ page }) => {
    const who = await makeFriend('gatex', { phone: null, ack: false })
    await cardLogin(page, who)

    // The gate won: the explainer view, and NO modal over it.
    await expect(page).toHaveURL(/\/ako-to-funguje$/)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'explainer')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Answer it the way a friend does…
    await page.getByTestId('explainer-done').click()
    await expect(page).toHaveURL(/\/$/)

    // …and only now is it this friend's turn to be asked for a phone.
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText(PROFILE_TITLE)
    await expect(page.getByRole('dialog').getByLabel('Mobil *')).toHaveValue('')
  })

  // ⚠ THE TERM CLARIFICATION (c) DOES NOT NAME. `showCredentialSetup` is the
  // transition-mode credential dialog (03 §UC-FL-011) — another non-dismissable
  // `NeoModal` raised straight from the handshake — so without it in the trigger this
  // modal stacks on it, scrim over scrim, for a credential-less friend with no phone.
  test('⚠ it waits for the AUTO-RAISED credential-setup dialog too', async ({ page }) => {
    const who = await makePlainFriend('setupgate', { phone: null })

    await muteGuestCounts(page)
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'transition' } }))
    await page.route('**/api/friends/login-list', (route) =>
      route.fulfill({ json: [{ id: who.id, name: who.name, hasCredentials: false }] })
    )
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/')
    await page.getByRole('combobox').click()
    await page.getByRole('option', { name: who.name }).click()
    await page.getByPlaceholder('Zadajte heslo').fill(FRIENDS_PASSWORD)
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()

    const setup = page.getByRole('dialog')
    await expect(setup.getByRole('heading', { name: 'Nastavte si osobné prihlásenie' })).toBeVisible()
    // ALONE while it is up.
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.locator('.modal-layer')).toHaveCount(1)
    await expect(setup).not.toContainText(PROFILE_TITLE)

    await setup.getByRole('button', { name: 'Neskôr' }).click()

    // …and now the profile modal takes its turn.
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText(PROFILE_TITLE)
    await expect(page.getByRole('dialog').getByLabel('Mobil *')).toHaveValue('')
  })

  // ⚠⚠ THE REGRESSION REVIEW FOUND, AND IT IS THE COMMON CASE — not an edge.
  //
  // PI-T10's first pass enumerated „the gates clarification (c) names, plus
  // `showCredentialSetup`" and stopped. The landing's own STATE modals (§UC-PI-006/007)
  // raise themselves with no friend action too, and `closed` is the normal state for
  // most of the month — so a phone-less friend logging in then got BOTH, measured as
  // `dialogs=2 modal-layers=2`. The enumeration was narrower than the class its own
  // source comment names („every surface that raises itself without the friend asking").
  //
  // ⚠ THE ORDER IS „STATE MODAL FIRST": clarification (c) says the auto-open runs AFTER
  // the other surfaces resolve, and the state modal is the landing explaining why there
  // is nothing to order. Both halves are asserted in ONE document — alone while it is
  // up, and arriving the moment it is dismissed — because either half alone passes on
  // the wrong build.
  const closedCycle = {
    id: 90_001, name: 'PI-T10 Closed Stub', status: 'completed',
    created_at: '2026-09-01 10:00:00', total_friends: 0, expected_date: null,
    type: 'coffee', plan_note: null, opens_at: null, closes_at: null, stage: null,
    parcel_enabled: 0, parcel_fee: 0, hasOrder: false, orderTotal: 0, orderStatus: null,
    orderKilos: 0, orderItemCount: 0, orderPickupName: null, orderPacketa: false,
    orderPaid: false, orderHandedOver: false,
  }

  test('⚠ it waits for the CLOSED landing\'s state modal — never two modals at once', async ({ page }) => {
    const who = await makePhonelessFriend('closed')
    // One `completed` round and nothing else ⇒ `resolveLanding()` reports `closed`,
    // which auto-mounts `LandingStateModal` (§UC-PI-006).
    await page.route('**/api/friends/cycles*', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify([closedCycle]),
    }))
    await cardLogin(page, who)

    // EXACTLY ONE dialog, and it is the state modal — not the profile form.
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.locator('.modal-layer')).toHaveCount(1)
    const state = page.getByRole('dialog')
    await expect(state.locator('.m-title')).toHaveText('Objednávky sú zatvorené')
    await expect(state).not.toContainText(PROFILE_TITLE)

    // Dismiss it the way a friend does, and the profile modal takes its turn — the
    // terms are computeds, so this is a queue and not a race.
    await state.getByRole('button', { name: 'Prezrieť ponuku' }).click()
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText(PROFILE_TITLE)
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.getByRole('dialog').getByLabel('Mobil *')).toHaveValue('')
  })

  // ⚠ THE LOCKED HALF, and it exists because M16 removed BOTH terms at once and the
  // `closed` test alone could not tell them apart. Deleting `!showLockedModal.value` by
  // itself would otherwise be a silent mutation — this row's own standing lesson.
  // §UC-PI-007's „locked, NO own order" branch is the same treatment with another title.
  test('⚠ …and for the LOCKED landing\'s state modal, which is a separate term', async ({ page }) => {
    const who = await makePhonelessFriend('locked')
    await page.route('**/api/friends/cycles*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      // `locked` + `hasOrder: false` is the ONE discriminator for this modal: a friend
      // who ordered gets the own-order card and never sees it.
      body: JSON.stringify([{ ...closedCycle, id: 90_002, status: 'locked', hasOrder: false }]),
    }))
    await cardLogin(page, who)

    await expect(page.getByRole('dialog')).toHaveCount(1)
    const state = page.getByRole('dialog')
    await expect(state.locator('.m-title')).toHaveText('Objednávky sú uzamknuté')
    await expect(state).not.toContainText(PROFILE_TITLE)

    await state.getByRole('button', { name: 'Prezrieť ponuku' }).click()
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText(PROFILE_TITLE)
    await expect(page.getByRole('dialog')).toHaveCount(1)
  })

  // ⚠⚠ THE PIN THAT REPLACES A HAND-KEPT LIST, and it exists because the list was wrong
  // TWICE: round 1 missed the two landing STATE modals, round 2 missed the VOUCHER
  // overlay — each time under a comment that states the predicate as a CLASS („every
  // surface that raises itself without the friend asking") and then enumerates. A class
  // rule with a complete-LOOKING list under it is worse than no list.
  //
  // So this walks the SOURCE the way the derivation says to: every overlay MOUNT in
  // `FriendPortalSession.vue` — `<NeoModal>`, `<LandingStateModal>`, `<NeoDrawer>` and
  // the teleported `fixed inset-0` voucher div — must be EITHER a term of the auto-open
  // trigger OR in the exclusion list below WITH a reason. An eighth self-raising overlay
  // therefore reds here instead of silently stacking on the profile form.
  test('⚠ SOURCE: every overlay mount is either a trigger term or a documented non-term', () => {
    const file = resolve(HERE, '..', '..', 'frontend', 'src', 'views', 'FriendPortalSession.vue')
    expect(existsSync(file), file).toBe(true)
    const src = readFileSync(file, 'utf8')
    // Readability gate (the PI-T3 rule): a regex that silently matched nothing would
    // make every assertion below vacuous.
    expect(src.length, 'the component source is readable').toBeGreaterThan(50_000)

    const mounts = [
      ...[...src.matchAll(/<(?:NeoModal|LandingStateModal|NeoDrawer)\b[^>]*?\sv-if="([^"]+)"/gs)].map((m) => m[1]),
      ...[...src.matchAll(/<div\s+v-if="([^"]+)"[^>]*class="fixed inset-0[^"]*"/g)].map((m) => m[1]),
    ].map((expr) => expr.trim().split(/\s*&&\s*/)[0].replace(/^!/, ''))
    expect(mounts.length, 'the mount walk found nothing — the regex broke').toBeGreaterThanOrEqual(9)

    // The trigger's own negated terms, harvested from source. Line comments are stripped
    // first so a term merely NAMED in the prose above cannot count as one.
    const getter = src.match(/\(\)\s*=>\s*profileAutoOpenArmed\.value([\s\S]*?),\n\s*\(ready\)/)
    expect(getter, 'the auto-open trigger was not found — did it move?').toBeTruthy()
    const code = getter[1].split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    const terms = [...code.matchAll(/&&\s*!\s*([A-Za-z_$][\w$]*)\.value/g)].map((m) => m[1])

    // ⚠ EVERY exclusion carries its reason. „Needs a friend's click" and „is not an
    // overlay at all" are the only two admissible ones; anything else is a term.
    const NOT_SELF_RAISING = {
      showInviteModal: 'the „Pozvať" chip / drawer row — a friend clicks it',
      menuOpen: 'the hamburger — a friend clicks it',
    }

    const unaccounted = mounts.filter((id) => !terms.includes(id) && !(id in NOT_SELF_RAISING))
    expect(
      unaccounted,
      `overlay mount(s) that are neither an auto-open trigger term nor a documented ` +
      `non-term: ${JSON.stringify(unaccounted)}. If one of these can raise itself with ` +
      `no friend action it MUST join the trigger (18 §UC-PI-015); if it cannot, add it ` +
      `to NOT_SELF_RAISING with its reason.`
    ).toEqual([])

    // …and the other direction: the seven self-raising surfaces really are terms, so a
    // deleted term reds here too and not only in its behaviour test.
    for (const id of [
      'forcedPasswordChange', 'showCredentialSetup', 'showGooglePrompt', 'explainerGate',
      'showClosedModal', 'showLockedModal', 'showVoucherModal',
    ]) {
      expect(terms, `${id} must be a term of the auto-open trigger`).toContain(id)
    }
    // ⚠ `showProfileModal` is a term for a DIFFERENT reason — not „it raises itself" but
    // „it may already be open", and `openProfileModal()` re-seeds every field. It is
    // therefore NOT in NOT_SELF_RAISING (it is not an exclusion) and is asserted here so
    // deleting it reds in source as well as in its behaviour test.
    expect(terms, 'showProfileModal guards against re-prefilling an open modal').toContain('showProfileModal')
    // Non-vacuity for the harvest itself: a broken regex would make every `toContain`
    // above pass against an empty array only if it threw — this makes it explicit.
    expect(terms.length, 'the trigger-term harvest found nothing').toBeGreaterThanOrEqual(8)
  })

  // ⚠⚠ THE VOUCHER OVERLAY — the SEVENTH self-raising surface, and the worst one to
  // stack on. `onMounted` AWAITS `checkPendingVouchers()`, which raises it with no
  // friend action; it is a hand-rolled `fixed inset-0 z-50` teleport while
  // `.modal-layer` is `z-index: 200`, so the profile form paints OVER it — and the
  // decision underneath is one-shot and irreversible („Toto rozhodnutie je jednorazové
  // a nedá sa zmeniť"), with no dismiss, only accept or decline.
  test('⚠ it waits for the PENDING-VOUCHER overlay, which it would otherwise paint over', async ({ page }) => {
    const who = await makePhonelessFriend('voucher')
    await page.route('**/api/vouchers/pending*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      // ⚠ THE SHAPE IS LOAD-BEARING: the overlay renders
      // `voucher_amount.toFixed(2)` and the two discount fields, so a thinner stub
      // throws inside the render and the overlay never appears — which looks exactly
      // like „the fix works" and is how this test failed on its first run.
      body: JSON.stringify([{
        id: 777_001, friend_id: who.id, cycle_id: 1, cycle_name: 'PI-T10 Voucher Round',
        voucher_amount: 5, supplier_discount: 10, applied_discount: 5, status: 'pending',
      }]),
    }))
    await cardLogin(page, who)

    // The voucher is up and the profile form is NOT — asserted on the overlay itself,
    // because it is a teleported div and not a `role="dialog"`.
    const overlay = page.locator('.fixed.inset-0.z-50')
    await expect(overlay).toBeVisible()

    // ⚠ THE DISCRIMINATING ASSERTION GOES FIRST, deliberately. A dialog COUNT reds under
    // the mutation too, but it reds before this line ever runs — so ordering it first is
    // what proves the z-order claim is itself load-bearing and not carried by the count.
    // What the friend would actually hit: without the term the profile modal's e-mail
    // input sits over the voucher's own button (measured: `INPUT.inp`).
    const onTop = await overlay.getByRole('button').first().evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return hit ? `${hit.tagName}${hit.className ? '.' + String(hit.className).split(' ')[0] : ''}` : 'none'
    })
    expect(onTop, 'the voucher decision must be the thing the friend can click').not.toMatch(/^INPUT/)

    // …and the plain counts, which say the same thing the cheap way.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.modal-layer')).toHaveCount(0)

    // ⚠ THE QUEUE HALF — the same „arrives when the surface in front resolves" claim the
    // closed/locked tests make, and the direction a „never opens at all" mutation breaks.
    // The friend ANSWERS the voucher (it has no dismiss, only accept/decline)…
    await page.route('**/api/vouchers/*/resolve', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
    }))
    await overlay.getByRole('button', { name: /Nepotrebujem/ }).click()
    await expect(overlay).toHaveCount(0)

    // …and only now is it the profile modal's turn.
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText(PROFILE_TITLE)
    await expect(page.getByRole('dialog').getByLabel('Mobil *')).toHaveValue('')
  })

  // ⚠ THE RE-PREFILL, which is a term of a DIFFERENT kind — `showProfileModal` does not
  // raise itself, it is already up. `openProfileModal()` unconditionally re-seeds all
  // four fields, so without the term the sequence below wipes what the friend typed.
  //
  // ⚠ The shipped „unhydrated modal" test CANNOT see this: it signs in through
  // `signIn()` (a RESTORE), so `freshLogin` is false and the trigger never arms. This
  // one logs in through the card, which is the only way the two can collide.
  test('⚠ a late hydrate must NOT re-prefill a modal the friend already has open', async ({ page }) => {
    const who = await makePhonelessFriend('reprefill')

    // Hold the profile GET so the friend can get in front of it. The PATCH on the same
    // URL pattern still goes through.
    let release
    const held = new Promise((r) => { release = r })
    await page.route(`**/api/friends/${who.id}/profile`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await held
      await route.continue()
    })

    await cardLogin(page, who)
    // Nothing auto-opened: hydrate has not landed, so the trigger cannot be true yet.
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The friend opens Profil themselves and starts typing.
    await portalOpenProfile(page)
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.m-title')).toHaveText(PROFILE_TITLE)
    const typedName = `${who.name} TYPED`
    await dialog.getByLabel('Meno a priezvisko *').fill(typedName)
    await dialog.getByLabel('Mobil *').fill('0911 000 111')

    // NOW let the hydrate land, and WAIT for it — otherwise the assertion below could
    // pass simply because the response had not arrived yet.
    const landed = page.waitForResponse(
      (r) => r.url().includes(`/api/friends/${who.id}/profile`) && r.request().method() === 'GET'
    )
    release()
    await landed

    // The friend's typing survived. Without `!showProfileModal.value` the watch fires
    // here and `openProfileModal()` reassigns both fields from the server row.
    await expect(dialog.getByLabel('Meno a priezvisko *')).toHaveValue(typedName)
    await expect(dialog.getByLabel('Mobil *')).toHaveValue('0911 000 111')
    // …and exactly one modal is open — it was not re-opened on top of itself.
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.locator('.modal-layer')).toHaveCount(1)
  })
})
