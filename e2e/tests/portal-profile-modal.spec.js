import { test, expect, request as playwrightRequest } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'

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
    await expect(dialog.locator('.field-help').nth(0)).toHaveText('Celé meno. Uvádza sa na zásielke pri doručení Packetou a vidí ho správca aj kolegovia.')
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

    // The read-only box is a `div`, which `<label for>` cannot address at
    // all — it carries `aria-labelledby` instead, and getByLabel must still
    // resolve it.
    // ⚠ RETARGETED (case (a), FUP-T20): `Jedinečné ID` is removed, so its
    // getByLabel pin becomes the absence assertion. The property this test
    // exists for — programmatic label association on a non-input — is still
    // asserted, on the box that survives.
    await expect(dialog.getByLabel('Jedinečné ID')).toHaveCount(0)
    await expect(dialog.getByLabel('Užívateľské meno')).toHaveText(friend.username)

    // ⚠ RETARGETED (case (a), FUP-T20): the label was `Prihlasovacie meno *`
    // while the field writes `friends.name`. Same field, truthful label.
    await expect(dialog.getByLabel('Meno a priezvisko *')).toHaveValue(friend.name)
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
 * 07 §UC-IA-007 / 11 §UC-FC-002 state the rule as `grep -i prihlasovac
 * frontend/src/views/AdminFriends.vue` returning nothing. That grep named ONE
 * file, and the identical label lived in `FriendPortalSession.vue` on a field
 * that writes the same `friends.name` column — so the admin half was fixed by
 * module 11 while the friend half shipped the same lie to staging.
 *
 * The sweep is the `admin-friends-labels.spec.js` idiom (text AND the attributes
 * that render as copy), pointed at the friend portal with the profile modal open.
 * The property is an ABSENCE, because new copy alone would let a revert pass:
 * "Meno a priezvisko *" can be added while "Prihlasovacie meno" stays one row up.
 */
function collectCopy() {
  return async () => {
    const out = [document.body.innerText]
    for (const el of document.querySelectorAll('*')) {
      for (const attr of ['placeholder', 'title', 'aria-label', 'alt']) {
        const v = el.getAttribute(attr)
        if (v) out.push(v)
      }
    }
    return out.join('\n')
  }
}

test.describe('⚠ FUP-T20 — no copy on the friend surface claims the name is a login', () => {
  /**
   * The guard AS IT IS WRITTEN, executed. §UC-FC-002 / 07 §UC-IA-007 state it as a
   * grep over source, and CLAUDE.md now names BOTH views — so this test runs that
   * grep instead of trusting someone to. It is the half the DOM sweep below cannot
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

    const portalCopy = await page.evaluate(collectCopy())
    expect(portalCopy, 'the portal claims a login somewhere').not.toMatch(/prihlasovac/i)

    const dialog = await openProfile(page)
    const modalCopy = await page.evaluate(collectCopy())
    expect(modalCopy, 'the profile modal claims the name is a login').not.toMatch(/prihlasovac/i)

    // Non-vacuity: the sweep really does read this modal's copy.
    // ⚠ Case-INSENSITIVE: `.field-lbl` is `text-transform: uppercase` and
    // `innerText` applies text-transform, so these arrive as "MENO A PRIEZVISKO *"
    // (the standing CLAUDE.md trap). The absence assertions above are already
    // case-insensitive regexes, so they are unaffected.
    expect(modalCopy).toMatch(/meno a priezvisko \*/i)
    expect(modalCopy).toMatch(/užívateľské meno/i)
    // …and the modal is the one that used to carry the claim, on the field that
    // writes `friends.name`.
    await expect(dialog.getByLabel('Meno a priezvisko *')).toHaveValue(friend.name)

    // The password fold is copy too, and it is the one place a login-ish string
    // would be legitimate — it must still avoid the guarded substring.
    await dialog.getByRole('button', { name: 'Zmeniť heslo' }).click()
    await expect(dialog.getByLabel('Aktuálne heslo')).toBeVisible()
    const foldCopy = await page.evaluate(collectCopy())
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
    // ⚠ The NAME lives in `.s` since 2026-08-09; `.t` is the constant Podpultovka
    // wordmark. This test is about the name updating live, so it follows the name.
    await expect(page.locator('.appbar .titles .s')).toHaveText(who.name)

    const dialog = await openProfile(page)
    const renamed = `${who.name} R`
    await dialog.getByLabel('Meno a priezvisko *').fill(renamed)
    await dialog.getByRole('button', { name: 'Uložiť' }).click()

    // No reload anywhere: the appbar name is RD-FL-3's `getCurrentFriendName()`
    // reading `currentFriend`, which `saveProfile` patches in place.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.appbar .titles .s')).toHaveText(renamed)
    // The wordmark is not data and must NOT follow the rename.
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')

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

    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // On the wire: an untouched, unhydrated field is simply absent.
    expect(bodies.length, JSON.stringify(bodies)).toBe(1)
    expect(bodies[0]).toEqual({ name: who.name })

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
