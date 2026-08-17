import { test, expect } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// IA-T5 / 07 §UC-IA-007 — AdminFriends.vue: the relabel + the dead `?create=1` receiver.
//
// WHY THIS FILE EXISTS. The field labelled "Prihlasovacie meno *" in the "Nový priateľ"
// modal writes `friends.name` — a DISPLAY label. It never minted a login, so an admin who
// filled it in got a friend with no username and no password. That mislabelling is the
// bug the whole module started from; IA-T3/IA-T4 built the real credential path and this
// row removes the lie.
//
// The governing rule of §UC-IA-007 is deliberately stated as an ABSENCE — "no string in
// AdminFriends.vue may claim the name field is used for login" — so the assertions here
// are absences too. New copy alone would let a revert pass: "Meno *" can be added while
// "Prihlasovacie meno" stays one line above.
//
// ⚠ The sweep covers TEXT **and** ATTRIBUTES, and the attribute half is NOT redundant.
// The claim lived in three places — the table header, the modal `Label`, and a
// `placeholder=`. The first two are innerText, so against the TRUE pre-fix build the
// innerText half alone already fails; that is not what the attribute half is for. It is
// for the PARTIAL fix: a relabel that corrects the header and the Label but leaves the
// placeholder behind is invisible to `innerText` and would pass an innerText-only sweep.
// Verified by partial revert (placeholder only): `listCopy` passes, `modalCopy` fails.
// So do not "simplify" this back to `document.body.innerText`.
//
// ⚠⚠ SCOPE — AND THE COMMENT THAT WAS WRONG (corrected by FUP-T20). This block used to
// read: "`FriendPortalSession.vue` has an identical 'Prihlasovacie meno' label that is
// correct there (that field IS the login)". It was NOT the login. That label sat on the
// field binding `profileName`, which writes `friends.name` — the same DISPLAY column this
// file's whole reason for existing is about — and its own help line one row below said so
// ("Toto meno vidí správca a kolegovia."). So the friend portal shipped the identical lie
// to production while this file guarded the admin half, because §UC-FC-002's grep guard
// named ONE file.
//
// The guard is now BOTH views: `grep -i prihlasovac frontend/src/views/AdminFriends.vue
// frontend/src/views/FriendPortalSession.vue` must return nothing, and the friend half is
// machine-checked by the copy sweep in `portal-profile-modal.spec.js` (which owns that
// modal). Nothing here touches the friend surface — every assertion below is still scoped
// to `/admin/friends`.
//
// ⚠ The substring is legitimately present in `AdminInvitations.vue` and
// `InviteRegister.vue`, where it labels a real `friends.username` field. The guard is
// "no view that edits `friends.name` may call it a login", not "the word is banned".
//
// ⚠ "Prihlásenie" (the credentials column header) is NOT a violation and is asserted
// present below: it labels the column showing whether a friend HAS credentials, which is
// true. It also does not match the spec's literal `prihlasovac` grep.

// ⚠ Logs in through the UI. The backend keeps exactly ONE live admin session, so any
// API-context token minted elsewhere in the same run is invalidated by these tests
// (the portal-transactions-modal.spec.js precedent). This file uses no API context.
// ⚠ No `addInitScript(localStorage.clear)` here — it re-runs on EVERY navigation, so it
// would wipe the admin token on the very next `goto` and bounce us back to the login
// screen. Each test gets a fresh context, so storage already starts empty.
async function loginAsAdmin(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

// Every rendered string a human can read: visible text plus the attributes that render
// as copy (placeholder, title, aria-label, alt, value on buttons).
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

test.describe('AdminFriends — the name field no longer claims to be a login', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/admin/friends')
    await expect(page.getByRole('heading', { name: /Priatelia/ }).first()).toBeVisible()
  })

  test('the table header reads "Meno a priezvisko", not "Prihlasovacie meno"', async ({ page }) => {
    const header = page.locator('thead tr').first()
    await expect(header).toBeVisible()
    // RETARGETED (e2e-immutability case (a), 11 §UC-FC-008 #1): FC-T2 mandates the
    // relabel "Meno" → "Meno a priezvisko" (11 §UC-FC-002). The absence assertions
    // below — the property this file exists for — stay verbatim.
    await expect(header.getByText('Meno a priezvisko', { exact: true })).toBeVisible()
    // The absence is the actual acceptance criterion.
    await expect(header.getByText(/Prihlasovacie/i)).toHaveCount(0)
    // Non-vacuity + the deliberate keep: the credentials column still says "Prihlásenie",
    // which is true of what that column shows.
    await expect(header.getByText('Prihlásenie', { exact: true })).toBeVisible()
  })

  test('the "Nový priateľ" modal labels the field "Meno a priezvisko *", with no placeholder and the new hint', async ({ page }) => {
    await page.getByRole('button', { name: /Pridať priateľa|Pridať prvého priateľa/ }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Nový priateľ')).toBeVisible()

    // RETARGETED (e2e-immutability case (a), 11 §UC-FC-008 #1): "Meno *" →
    // "Meno a priezvisko *" and the hint follows 11 §UC-FC-003's verbatim wording
    // (chosen specifically to pass the `prihlasovac` grep guard). The
    // /Prihlasovacie meno/i and /pri prihlasovaní/i ABSENCE assertions stay verbatim.
    await expect(dialog.getByText('Meno a priezvisko *', { exact: true })).toBeVisible()
    await expect(dialog.getByText(/Prihlasovacie meno/i)).toHaveCount(0)

    // The name input is the first one in the dialog and carries NO placeholder at all
    // (§UC-IA-007 removes it rather than rewording it).
    const nameInput = dialog.locator('input').first()
    await expect(nameInput).toHaveJSProperty('placeholder', '')

    await expect(dialog.getByText('Celé meno. Vidí ho správca a kolegovia; na prihlásenie slúži užívateľské meno.')).toBeVisible()
    await expect(dialog.getByText(/pri prihlasovaní/i)).toHaveCount(0)
  })

  test('no rendered copy on the page or in the modal claims the name is a login', async ({ page }) => {
    // Closed state.
    const listCopy = await page.evaluate(collectCopy())
    expect(listCopy, 'friends list still claims a login').not.toMatch(/prihlasovac/i)

    // Open state — the modal is where the claim lived.
    await page.getByRole('button', { name: /Pridať priateľa|Pridať prvého priateľa/ }).first().click()
    await expect(page.getByRole('dialog').getByText('Nový priateľ')).toBeVisible()
    const modalCopy = await page.evaluate(collectCopy())
    expect(modalCopy, 'new-friend modal still claims a login').not.toMatch(/prihlasovac/i)

    // Non-vacuity: the sweep really does see this page's copy, including attributes.
    expect(modalCopy).toContain('Nový priateľ')
    expect(modalCopy).toMatch(/interná poznámka/i)
  })
})

test.describe('AdminFriends — the retired ?create=1 prefill receiver', () => {
  test('/admin/friends?create=1&name=X opens the plain list with no modal', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/admin/friends?create=1&name=Testovaci%20Host&phone=0900111222&email=host@example.com')

    // Assert the ABSENCE first: a radix dialog `aria-hidden`s the rest of the page, so
    // with the prefill block still alive the heading check below fails for a confusing
    // reason ("heading not found") instead of the real one.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('Nový priateľ')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /Priatelia/ }).first()).toBeVisible()
    await expect(page.getByText('Testovaci Host')).toHaveCount(0)

    // Give the retired `router.replace` cleanup a chance to fire before asserting it
    // did not: the block ran after an awaited `loadFriends()`.
    await page.waitForTimeout(500)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // The URL is left exactly as visited — the block that rewrote it is gone.
    expect(new URL(page.url()).search).toContain('create=1')
  })
})
