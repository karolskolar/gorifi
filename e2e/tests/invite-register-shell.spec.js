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
let adminToken = ''

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
  const username = `ireg_${uniq}`.slice(0, 30)
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
    const email = page.getByLabel(/^email$/i)
    for (const [field, label] of [[name, 'name'], [phone, 'phone'], [email, 'email']]) {
      await expect(field, label).toHaveClass(/\binp\b/)
      // ⚠ NO placeholder (the 2026-08-10 login decision). Asserted as ABSENT —
      // that is what catches one coming back, which dropping the line would not.
      await expect(field, label).not.toHaveAttribute('placeholder', /./)
    }
    await expect(phone).toHaveAttribute('type', 'tel')
    await expect(email).toHaveAttribute('type', 'email')
    await expect(page.locator('.field-lbl')).toHaveCount(3)

    // The optional-email hint moved OUT of the label into `.field-help`:
    // `.field-lbl` is `text-transform:uppercase`, so a parenthetical there shouts.
    await expect(page.locator('.field-help')).toHaveText(/Nepovinné/)
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
