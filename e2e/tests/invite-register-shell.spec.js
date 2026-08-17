import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// The public invite-registration screen (`/invite/:code`) on the Podpultovka skin.
//
// This route had NO UI spec at all — it was the last friend-facing screen still on
// the old shadcn skin (Card/Input/Label/Button/Alert + the Goriffee logo), and it
// is reached by every NEW member, i.e. it is the first thing a person ever sees of
// this app. Restyled 2026-08-12; this file is its first regression net.
//
// It has no design-canon screen of its own (module 03 puts the route out of
// scope), so the assertions pin the two PRECEDENTS it was composed from — the
// modern login's branded column + `.card` form, and the guest dead-link card for
// the terminal state — plus the three things only a measurement can catch:
// the wrapped-headline leading, the disabled-until-valid button, and 320px.

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let inviteCode = ''
let inviterName = ''
let inviterUsername = ''
let adminToken = ''

// Every successful registration must carry a distinct phone: the shipped pending
// dedupe (`idx_invitations_phone_pending`) 409s a repeat, so a shared number would
// make the second test in a file fail for a reason that is not under test.
let phoneSeq = 0
function uniquePhone() {
  phoneSeq += 1
  return `+4219${String(Date.now() % 1e5).padStart(5, '0')}${String(phoneSeq).padStart(3, '0')}`
}

// `GET /api/invitations` is `SELECT i.*`, so `username` surfaces with no route
// change (the `source`/GSO-T10 precedent) — this is the only reader of the stored
// value until UC-IA-005 approval lands.
async function pendingByPhone(phone) {
  const list = await ctx.get('/api/invitations?status=pending', { headers: { 'X-Admin-Token': adminToken } })
  expect(list.status()).toBe(200)
  return (await list.json()).find((r) => r.phone === phone) || null
}

function register(data) {
  return ctx.post('/api/invitations/register', { data })
}

// Provisioning idiom copied from self-hosted-fonts.spec.js / portal-appbar.spec.js:
// a real friend, a real Bearer session, and the friend's own invite code read from
// `GET /invitations/my-code` — `friends.js` strips `invite_code` from every friend
// response, so this is the only route to a valid code.
test.beforeAll(async ({ baseURL }) => {
  ctx = await playwrightRequest.newContext({ baseURL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
  const admin = (p, o = {}) => ctx[o.method || 'get'](p, {
    headers: { 'X-Admin-Token': adminToken },
    ...(o.data ? { data: o.data } : {}),
  })

  inviterName = `E2E Inviter ${uniq}`
  // Kept in a module-level ref too: it is a REAL taken username, which is what the
  // 409 courtesy-check test below needs (UC-IA-003).
  const username = `ireg_${uniq}`.slice(0, 30)
  inviterUsername = username
  const created = await admin('/api/friends', { method: 'post', data: { name: inviterName } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()
  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(auth.status(), 'friend login').toBe(200)
  const first = (await auth.json()).token
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${first}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || first

  const code = await ctx.get('/api/invitations/my-code', { headers: { Authorization: `Bearer ${token}` } })
  expect(code.status(), 'my-code').toBe(200)
  inviteCode = (await code.json()).inviteCode
  expect(inviteCode, 'invite code').toBeTruthy()
})

test.afterAll(async () => { await ctx?.dispose() })

// ⚠ GA-T8 — THIS FILE MUST STAY HERMETIC, and after 10 §UC-GA-008 it stops being so
// on its own. The invite form now renders a GIS button whenever the target serves a
// `googleClientId`, so every `goto('/invite/<valid>')` below would issue REAL,
// uncontrolled requests to `accounts.google.com` where it previously issued none —
// making a shell spec depend on network egress and on Google's uptime. Every other
// GIS-rendering UI test in the repo stubs the host (`google-auth.spec.js`); this
// `beforeEach` does the same, for every test in the file at once.
//
// It fulfils rather than aborts on purpose: an aborted script puts the view in its
// LOADER-FAILURE path (the block renders, the mount stays empty), which is an error
// state, not the state a shell spec should be measuring. The stub defines the
// namespace the loader waits for and renders a marker, so the page is in its normal
// shape.
//
// ⚠ RESIDUAL, stated because the 320px test below silently depends on it: the stub
// renders a plain `<div>`, NOT the real cross-origin iframe. So no test in this repo
// covers the REAL GIS button's geometry at 320px — with no egress the mount would
// simply stay empty and the overflow assertion would pass vacuously. That
// measurement belongs to the manual staging walkthrough (§UC-GA-013), together with
// the CSP one.
const GIS_STUB_SRC = `
  window.google = { accounts: { id: {
    initialize: () => {},
    renderButton: (el) => {
      const marker = document.createElement('div')
      marker.setAttribute('data-testid', 'gis-stub-button')
      marker.textContent = 'Prihlásiť sa cez Google'
      el.appendChild(marker)
    },
  } } };
`

test.beforeEach(async ({ page }) => {
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: GIS_STUB_SRC,
  }))
})

test.describe('Invite registration — the restyled shell', () => {
  test('the chrome is the Podpultovka wordmark, in EVERY state, and no Goriffee mark', async ({ page }) => {
    // Invalid code first: the chrome must render OUTSIDE the state branch, so
    // someone who mistyped a link can still tell what they reached.
    await page.goto(`/invite/NOPE-${uniq}`)
    await expect(page.getByTestId('invite-invalid')).toBeVisible()

    const titles = page.locator('.appbar .titles')
    await expect(titles).toContainText('Podpultovka')
    await expect(titles).toContainText('Registrácia')
    await expect(page.locator('.appbar .chip')).toHaveText('Na pozvánku')
    // The full header stack: appbar → hazard tape → ticker (UC-DS-006).
    await expect(page.locator('.hazard')).toHaveCount(1)
    await expect(page.locator('.ticker')).toContainText('VSTUP LEN NA POZVÁNKU')
    // The theme scope itself — this is the "new design" claim in one assertion.
    await expect(page.locator('.app')).toHaveCount(1)

    await expect(page.getByAltText('Goriffee')).toHaveCount(0)
    await expect(page.locator('img[src*="goriffee"]')).toHaveCount(0)

    // Same chrome on the valid-code form.
    await page.goto(`/invite/${inviteCode}`)
    await expect(page.getByTestId('invite-form')).toBeVisible()
    await expect(page.locator('.appbar .titles')).toContainText('Podpultovka')
    await expect(page.getByAltText('Goriffee')).toHaveCount(0)
  })

  test('invalid code: the g-dead composition — rotated danger badge, display headline, no form', async ({ page }) => {
    await page.goto(`/invite/NOPE2-${uniq}`)
    const card = page.getByTestId('invite-invalid')
    await expect(card).toBeVisible()
    await expect(card).toHaveClass(/\bcard\b/)

    const badge = card.locator('.badge.danger')
    await expect(badge).toContainText('Slepá ulička')
    // ⚠ The padlock and the label must share ONE line. Tailwind preflight sets
    // `svg{display:block}`, which breaks an icon badge onto two lines inside a
    // plain `inline-block` — the guest dead card's documented trap. One line means
    // the badge stays close to its own font size in height.
    await expect(badge.locator('svg')).toHaveCount(1)
    const badgeBox = await badge.boundingBox()
    expect(badgeBox.height, `icon badge wrapped to two lines: ${badgeBox.height}px`).toBeLessThan(46)

    await expect(card.locator('h1.h-screen')).toHaveText('Pozvánka neplatí')
    await expect(card).toContainText('Požiadajte o nový odkaz priateľa, ktorý vás pozval.')
    // No form on a dead code.
    await expect(page.locator('input.inp')).toHaveCount(0)
    await expect(page.getByTestId('invite-form')).toHaveCount(0)
  })

  test('valid code: theme form controls, the inviter badge, and NO placeholders', async ({ page }) => {
    await page.goto(`/invite/${inviteCode}`)
    await expect(page.getByTestId('invite-form')).toBeVisible()

    await expect(page.getByTestId('invite-inviter')).toHaveText(`Pozvánka od ${inviterName}`)
    await expect(page.getByTestId('invite-inviter')).toHaveClass(/\bbadge\b/)

    // Native inputs + theme classes, label-associated — no `ui/` components.
    const name = page.getByLabel(/^meno a priezvisko$/i)
    const phone = page.getByLabel(/^telefón$/i)
    // 07 §UC-IA-008 item 3: the optional username field is MANDATED by
    // §UC-IA-004, so the no-placeholder loop and the `.field-lbl` count below are
    // re-pointed at the 4-field form. Both still protect the same properties.
    const username = page.getByLabel(/^prihlasovacie meno$/i)
    const email = page.getByLabel(/^email$/i)
    for (const [field, label] of [[name, 'name'], [phone, 'phone'], [username, 'username'], [email, 'email']]) {
      await expect(field, label).toHaveClass(/\binp\b/)
      // ⚠ NO placeholder (the 2026-08-10 login decision). Asserted as ABSENT —
      // that is what catches one coming back, which dropping the line would not.
      await expect(field, label).not.toHaveAttribute('placeholder', /./)
    }
    await expect(phone).toHaveAttribute('type', 'tel')
    await expect(email).toHaveAttribute('type', 'email')
    // ⚠ GA-T8 UPDATE (10 §UC-GA-008), an e2e-immutability case (a) edit. The
    // optional Google block adds a FIFTH `.field-lbl`, so a bare count of 4 became
    // false — and bumping it to 5 would have made this assertion depend on whether
    // the target has `GOOGLE_CLIENT_ID` set, i.e. it would flip between two correct
    // deployments. Re-pointed at `label.field-lbl` instead: the four FIELDS each
    // have a real `<label for>` (which is what "label-associated, no `ui/`
    // components" means here), while the Google block's is a `<div>` heading over a
    // GIS iframe that owns no input. Strictly more precise, and config-independent.
    await expect(page.locator('label.field-lbl')).toHaveCount(4)

    // The username field's own constraints (§UC-IA-004's markup table).
    await expect(username).toHaveAttribute('type', 'text')
    await expect(username).toHaveAttribute('maxlength', '30')
    await expect(username).toHaveAttribute('autocapitalize', 'none')
    await expect(username).toHaveAttribute('autocorrect', 'off')
    // And the `maxlength` mirror of UC-IA-003's server bounds on the other three.
    await expect(name).toHaveAttribute('maxlength', '120')
    await expect(phone).toHaveAttribute('maxlength', '32')
    await expect(email).toHaveAttribute('maxlength', '160')

    // The optional-email hint moved OUT of the label into `.field-help`:
    // `.field-lbl` is `text-transform:uppercase`, so a parenthetical there shouts.
    // ⚠ 07 §UC-IA-008 item 3: there are TWO `.field-help` blocks now, so this
    // single-element locator became strict-mode-ambiguous. SCOPED to the email
    // field's own help (via its testid) rather than weakened to `.first()` — the
    // point of the assertion is that the EMAIL hint still says "Nepovinné".
    await expect(page.getByTestId('invite-email-help')).toHaveText(/Nepovinné/)
    // ⚠ GA-T8 UPDATE (10 §UC-GA-008), the same case (a) edit and the same reason:
    // the Google block carries a THIRD `.field-help`. Scoped to the FIELD rows —
    // the card's direct children other than the Google block — so the assertion
    // still says "each of the two optional fields explains itself, and nothing
    // else does", on a configured target and an unconfigured one alike.
    await expect(page.locator('.card > div:not([data-testid="invite-google"]) .field-help')).toHaveCount(2)
    // The username hint is pinned VERBATIM from §UC-IA-004's markup table — it is
    // the only statement of the charset the applicant ever sees, and the en dash
    // in "3–30" is part of it.
    await expect(page.locator('.field-help').nth(0))
      .toHaveText('Nepovinné. 3–30 znakov: malé písmená, čísla, bodka, podčiarknik, pomlčka.')
    await expect(page.getByText(/^Email$/)).toBeVisible()

    const submit = page.getByRole('button', { name: 'Odoslať registráciu' })
    await expect(submit).toHaveClass(/\bbtn\b.*\baccent\b/)
  })

  test('the copy is vy-form throughout — no informal address, no gendered participle at the reader', async ({ page }) => {
    await page.goto(`/invite/${inviteCode}`)
    await expect(page.getByTestId('invite-form')).toBeVisible()
    // ⚠ CASE-INSENSITIVE, and not out of laziness: `innerText` returns text as
    // RENDERED, so it applies `text-transform`. Three classes on this screen are
    // uppercase (`.h-screen`, `.badge`, `.field-lbl`), so a literal
    // `toContain('Pozvánka od')` fails against "POZVÁNKA OD …" while the copy is
    // perfectly correct. (`toHaveText` reads `textContent` and is NOT transformed —
    // which is why the element-level assertions elsewhere in this file can be
    // exact.) `innerText` is still the right source here: it is what a person sees.
    const shown = await page.locator('.app').innerText()

    // The retired old-skin strings, each an informal or gendered address.
    expect(shown).not.toMatch(/Pozval\/a ťa/i)
    expect(shown).not.toMatch(/Tvoje meno/i)
    expect(shown).not.toMatch(/Popros/i)
    expect(shown).not.toMatch(/\bťa\b/i)
    // And the replacement is present.
    expect(shown).toMatch(/Pozvánka od/i)
    expect(shown).toMatch(/Nechajte nám kontakt/i)
  })

  test('the submit button is disabled until name AND phone are filled', async ({ page }) => {
    await page.goto(`/invite/${inviteCode}`)
    const submit = page.getByRole('button', { name: 'Odoslať registráciu' })
    await expect(submit).toBeDisabled()

    await page.getByLabel(/^meno a priezvisko$/i).fill('Testovací Kolega')
    await expect(submit, 'name alone is not enough').toBeDisabled()

    await page.getByLabel(/^telefón$/i).fill('+421900000001')
    await expect(submit).toBeEnabled()

    // Whitespace-only must not satisfy it — the guard trims.
    await page.getByLabel(/^meno a priezvisko$/i).fill('   ')
    await expect(submit, 'whitespace-only name').toBeDisabled()
  })

  test('a real submit reaches the success state AND lands in the admin invitations list', async ({ page }) => {
    const phone = `+421900${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
    const applicant = `E2E Applicant ${uniq}`

    await page.goto(`/invite/${inviteCode}`)
    await page.getByLabel(/^meno a priezvisko$/i).fill(applicant)
    await page.getByLabel(/^telefón$/i).fill(phone)
    await page.getByLabel(/^email$/i).fill(`applicant-${uniq}@example.com`)
    await page.getByRole('button', { name: 'Odoslať registráciu' }).click()

    const success = page.getByTestId('invite-success')
    await expect(success).toBeVisible()
    await expect(success.locator('h1.h-screen')).toContainText('Registrácia je odoslaná')
    await expect(success.locator('h1 .hl')).toHaveText('odoslaná')
    await expect(success).toContainText('Ozveme sa vám')
    // Deliberately NO redundant "Odoslané" badge above the headline (the g-confirm
    // declutter rule: badge + headline + appbar subtitle = one fact said three times).
    await expect(success.locator('.badge')).toHaveCount(0)

    // The restyle must not have broken the wiring: the invitation is really there.
    const list = await ctx.get('/api/invitations?status=pending', { headers: { 'X-Admin-Token': adminToken } })
    expect(list.status()).toBe(200)
    const rows = await list.json()
    const mine = rows.find((r) => r.name === applicant)
    expect(mine, `submitted invitation not found for ${applicant}`).toBeTruthy()
    expect(mine.phone).toBe(phone)
  })

  test('a failed submit shows `.banner.danger.slim` in the card — and no success state', async ({ page }) => {
    await page.route('**/api/invitations/register', (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Chyba servera' }) }))

    await page.goto(`/invite/${inviteCode}`)
    await page.getByLabel(/^meno a priezvisko$/i).fill('Testovací Kolega')
    await page.getByLabel(/^telefón$/i).fill('+421900000002')
    await page.getByRole('button', { name: 'Odoslať registráciu' }).click()

    const banner = page.locator('.banner.danger.slim')
    await expect(banner).toBeVisible()
    await expect(banner.locator('.dot')).toHaveCount(1)
    await expect(page.getByTestId('invite-success')).toHaveCount(0)
    await expect(page.getByTestId('invite-form')).toBeVisible()
  })

  // ⚠ GEOMETRY, not text. `.hl` paints a filled block plus a `0 4px 0` ink
  // underline shadow, and `.h-screen` is `line-height:.95` — so a headline that
  // WRAPS (both of these do at 480px) overlaps the previous line's descenders and
  // clips the underline unless the call site overrides the leading to 1.3. No text
  // assertion can see that; this is the same check guest-payment-modal.spec.js
  // makes for the g-confirm headline.
  test('the wrapped headlines carry enough leading for the `.hl` underline', async ({ page }) => {
    for (const [route, testid] of [[`/invite/${inviteCode}`, 'invite-form']]) {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(route)
      await expect(page.getByTestId(testid)).toBeVisible()

      const h1 = page.locator('h1.h-screen')
      const metrics = await h1.evaluate((el) => {
        const hl = el.querySelector('.hl')
        return {
          lineHeight: getComputedStyle(el).lineHeight,
          fontSize: parseFloat(getComputedStyle(el).fontSize),
          h1Top: el.getBoundingClientRect().top,
          hlTop: hl.getBoundingClientRect().top,
          wrapped: el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).fontSize) * 1.2,
        }
      })
      // It really is a two-line headline at phone width, or this proves nothing.
      expect(metrics.wrapped, `headline did not wrap at 390px: ${JSON.stringify(metrics)}`).toBe(true)
      // The highlighted word sits on the SECOND line, at least one font-size down.
      expect(metrics.hlTop - metrics.h1Top,
        `.hl block sits too close to line 1 — leading override lost: ${JSON.stringify(metrics)}`)
        .toBeGreaterThan(metrics.fontSize * 0.95)
    }
  })

  // ── 07 §UC-IA-004: the username field end to end ──────────────────────────
  test('a submitted username is lowercased and trimmed on the way in', async ({ page }) => {
    const phone = uniquePhone()
    const applicant = `E2E Username ${uniq}`
    // Typed with a capital and surrounding spaces — the acceptance criterion is
    // that ' Lego ' arrives as `lego`. The trim is the view's; the lowercase is
    // applied on BOTH sides (view + server), and this asserts the observable end.
    const wanted = `Lego_${uniq}`.slice(0, 30)

    await page.goto(`/invite/${inviteCode}`)
    await page.getByLabel(/^meno a priezvisko$/i).fill(applicant)
    await page.getByLabel(/^telefón$/i).fill(phone)
    await page.getByLabel(/^prihlasovacie meno$/i).fill(`  ${wanted}  `)
    await page.getByRole('button', { name: 'Odoslať registráciu' }).click()

    await expect(page.getByTestId('invite-success')).toBeVisible()

    const row = await pendingByPhone(phone)
    expect(row, `invitation not found for ${phone}`).toBeTruthy()
    expect(row.name).toBe(applicant)
    expect(row.username).toBe(wanted.toLowerCase())
  })

  test('leaving the username blank still registers — and stores no username', async ({ page }) => {
    const phone = uniquePhone()
    const applicant = `E2E No Username ${uniq}`

    await page.goto(`/invite/${inviteCode}`)
    await page.getByLabel(/^meno a priezvisko$/i).fill(applicant)
    await page.getByLabel(/^telefón$/i).fill(phone)
    // The username input is deliberately left untouched: the button must not gate
    // on it, and the body must omit the field entirely.
    await expect(page.getByRole('button', { name: 'Odoslať registráciu' })).toBeEnabled()

    // The request body itself, not just its effect: an empty field must send NO
    // `username` key, because a `''` would be a different code path server-side.
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/invitations/register') && r.method() === 'POST'),
      page.getByRole('button', { name: 'Odoslať registráciu' }).click(),
    ])
    expect(Object.keys(request.postDataJSON())).not.toContain('username')

    await expect(page.getByTestId('invite-success')).toBeVisible()

    const row = await pendingByPhone(phone)
    expect(row, `invitation not found for ${phone}`).toBeTruthy()
    expect(row.username, 'an empty username must be stored as NULL').toBeNull()
  })

  test('the username field sits between Telefón and Email in DOM order', async ({ page }) => {
    // §UC-IA-004's field-group table places the new input "between Telefón and
    // Email". The `.field-lbl`/`.inp` COUNT is already pinned above; this is the
    // one thing that count cannot see — a field reordered (or moved to the very
    // end) would still pass every other assertion in this file.
    await page.goto(`/invite/${inviteCode}`)
    await expect(page.getByTestId('invite-form')).toBeVisible()

    const ids = await page.locator('input.inp').evaluateAll((els) => els.map((el) => el.id))
    expect(ids).toEqual(['ir-name', 'ir-phone', 'ir-username', 'ir-email'])
  })

  test('a real 409 on a taken username shows the field message in the banner, AND the form stays filled for a retry', async ({ page }) => {
    // §UC-IA-004: "Server 400/409 with `field: 'username'` surfaces through the
    // view's existing error display; the form stays filled so the applicant can
    // retry." Only the API-level 400/409s were pinned above (invitations.js
    // directly) and the one UI-level failed-submit test mocks a generic 500 —
    // neither exercises a REAL field-specific error through the browser, and
    // neither checks that every field (not just the container) survives it.
    const phone = uniquePhone()
    const applicant = `E2E Retry ${uniq}`
    const email = `retry-${uniq}@example.com`

    await page.goto(`/invite/${inviteCode}`)
    await page.getByLabel(/^meno a priezvisko$/i).fill(applicant)
    await page.getByLabel(/^telefón$/i).fill(phone)
    await page.getByLabel(/^email$/i).fill(email)
    // `inviterUsername` is a REAL taken username (the friend created in
    // beforeAll), typed with a capital as a real applicant might.
    await page.getByLabel(/^prihlasovacie meno$/i).fill(inviterUsername.toUpperCase())
    await page.getByRole('button', { name: 'Odoslať registráciu' }).click()

    const banner = page.locator('.banner.danger.slim')
    await expect(banner).toBeVisible()
    // The route-local message, verbatim — the same string `invitations.js` sends
    // for this exact 409 (pinned at the API level in the describe block below).
    await expect(banner).toContainText('Toto prihlasovacie meno je už obsadené')
    await expect(page.getByTestId('invite-success')).toHaveCount(0)

    // The whole form, not just its container — every field the applicant typed.
    await expect(page.getByTestId('invite-form')).toBeVisible()
    await expect(page.getByLabel(/^meno a priezvisko$/i)).toHaveValue(applicant)
    await expect(page.getByLabel(/^telefón$/i)).toHaveValue(phone)
    await expect(page.getByLabel(/^email$/i)).toHaveValue(email)
    await expect(page.getByLabel(/^prihlasovacie meno$/i)).toHaveValue(inviterUsername.toUpperCase())

    // The retry itself succeeds without re-typing anything but the username.
    await page.getByLabel(/^prihlasovacie meno$/i).fill(`retryok_${uniq}`.slice(0, 30))
    await page.getByRole('button', { name: 'Odoslať registráciu' }).click()
    await expect(page.getByTestId('invite-success')).toBeVisible()

    const row = await pendingByPhone(phone)
    expect(row, `invitation not found for ${phone}`).toBeTruthy()
    expect(row.username).toBe(`retryok_${uniq}`.slice(0, 30))
  })

  test('no horizontal overflow at 320px, in every state', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })

    for (const route of [`/invite/NOPE3-${uniq}`, `/invite/${inviteCode}`]) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `document scrolls sideways at 320px on ${route}`).toBeLessThanOrEqual(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 07 §UC-IA-003 — `POST /invitations/register` hardening.
//
// API-level, because the form cannot produce these bodies: `maxlength` caps the
// inputs and the view always sends strings. The endpoint is PUBLIC and
// unauthenticated, so a malformed body is the ordinary case, not the exotic one —
// `{name: 123}` was a recorded 500 (a number has no `.trim()`).
//
// Every 400 must carry a `field` marker (the guest.js contract), so the form can
// point at the offending input.
test.describe('Invite registration — POST /register input hardening', () => {
  test('a non-string field is a 400 with a field marker, never a 500', async () => {
    // The recorded follow-up, verbatim.
    const numeric = await register({ invite_code: inviteCode, name: 123, phone: uniquePhone() })
    expect(numeric.status(), 'a numeric name used to 500 inside .trim()').toBe(400)
    const body = await numeric.json()
    expect(body.field).toBe('name')
    expect(body.error).toBeTruthy()

    // The other shapes an attacker actually sends. Each names its own field.
    for (const [field, value] of [
      ['invite_code', { toString: 1 }],
      ['name', ['a']],
      ['phone', true],
      ['email', 42],
      ['username', { a: 1 }],
    ]) {
      const res = await register({
        invite_code: inviteCode,
        name: 'Testovací Kolega',
        phone: uniquePhone(),
        [field]: value,
      })
      expect(res.status(), `${field}=${JSON.stringify(value)}`).toBe(400)
      expect((await res.json()).field, `${field} must be named in the 400`).toBe(field)
    }
  })

  test('the 120/32/160 bounds are enforced after trim, each naming its field', async () => {
    const over = [
      ['name', 'a'.repeat(121)],
      ['phone', '1'.repeat(33)],
      ['email', `${'a'.repeat(155)}@e.com`],
    ]
    for (const [field, value] of over) {
      const res = await register({
        invite_code: inviteCode,
        name: 'Testovací Kolega',
        phone: uniquePhone(),
        [field]: value,
      })
      expect(res.status(), `over-length ${field} (${value.length} chars)`).toBe(400)
      expect((await res.json()).field).toBe(field)
    }

    // Non-vacuity: exactly at the bound it still goes through, so the assertions
    // above are about the LIMIT and not about the field being rejected outright.
    const atLimit = await register({
      invite_code: inviteCode,
      name: 'a'.repeat(120),
      phone: uniquePhone(),
    })
    expect(atLimit.status(), 'a 120-char name is inside the bound').toBe(201)
  })

  test('an invalid username is a 400 with `field: username`', async () => {
    // The spec's own example. ⚠ It fails on LENGTH ONLY: `invitations.js`
    // lowercases before validating, so the uppercase is normalised away and the
    // charset branch is never reached by a capital. Case is never validated.
    const short = await register({
      invite_code: inviteCode, name: 'Testovací Kolega', phone: uniquePhone(), username: 'AB',
    })
    expect(short.status()).toBe(400)
    const shortBody = await short.json()
    expect(shortBody.field).toBe('username')

    // The charset half, on a value that is long enough to reach it.
    const badChars = await register({
      invite_code: inviteCode, name: 'Testovací Kolega', phone: uniquePhone(), username: 'ma ma',
    })
    expect(badChars.status()).toBe(400)
    const body = await badChars.json()
    expect(body.field).toBe('username')
    // ⚠ The message is ROUTE-LOCAL, not `validateUsername`'s return. The helper's
    // own string is diacritic-free and calls the field "Uzivatelske meno" — a THIRD
    // name for an input labelled "Prihlasovacie meno" whose sibling 409 also says
    // "prihlasovacie meno". Pinned as the EXACT string so a silent fall-back to the
    // helper's wording (which would still be a 400 with the right field) fails here.
    expect(body.error)
      .toBe('Prihlasovacie meno musí mať 3–30 znakov: malé písmená, čísla, bodka, podčiarknik, pomlčka.')
    // Both branches speak with one voice — the length rejection above too.
    expect(shortBody.error).toBe(body.error)
  })

  test('a username already taken by a friend is a 409 with `field: username`', async () => {
    const res = await register({
      invite_code: inviteCode,
      name: 'Testovací Kolega',
      phone: uniquePhone(),
      username: inviterUsername.toUpperCase(),
    })
    // Uppercase on the way in — the lowercase happens BEFORE the taken check, or
    // the collision would be missed and two friends would race for one login.
    expect(res.status(), 'a taken username must 409, not 201').toBe(409)
    expect((await res.json()).field).toBe('username')
  })

  test('an empty or absent username takes the unchanged happy path — stored NULL', async () => {
    // ⚠ THE REGRESSION THIS GUARDS: `validateUsername('')` returns "povinné", so
    // calling it unconditionally would 400 every registration that omits the
    // field — i.e. the shipped happy path. All four empty shapes must be 201.
    for (const [label, extra] of [
      ['absent', {}],
      ['empty string', { username: '' }],
      ['whitespace only', { username: '   ' }],
      ['null', { username: null }],
    ]) {
      const phone = uniquePhone()
      const res = await register({ invite_code: inviteCode, name: `E2E ${label} ${uniq}`, phone, ...extra })
      expect(res.status(), `username ${label}`).toBe(201)
      expect(await res.json()).toEqual({ success: true })

      const row = await pendingByPhone(phone)
      expect(row, `invitation not found for ${phone}`).toBeTruthy()
      expect(row.username, `username ${label} must store NULL`).toBeNull()
    }
  })

  test('the preserved contract: bad code 400, pending-phone dedupe 409, 201 shape', async () => {
    const bad = await register({ invite_code: `NOPE${uniq}`, name: 'Testovací Kolega', phone: uniquePhone() })
    expect(bad.status()).toBe(400)
    expect((await bad.json()).error).toBe('Neplatný kód pozvánky')

    const missing = await register({ invite_code: inviteCode, name: '  ', phone: uniquePhone() })
    expect(missing.status()).toBe(400)
    expect((await missing.json()).error).toBe('Meno a telefón sú povinné')

    // The invite code is still matched case-INSENSITIVELY (uppercased server-side).
    const phone = uniquePhone()
    const first = await register({ invite_code: inviteCode.toLowerCase(), name: `E2E Dedupe ${uniq}`, phone })
    expect(first.status(), 'a lowercased invite code must still resolve').toBe(201)

    const second = await register({ invite_code: inviteCode, name: `E2E Dedupe ${uniq}`, phone })
    expect(second.status()).toBe(409)
    expect((await second.json()).error).toBe('Registrácia s týmto číslom už existuje')
  })
})
