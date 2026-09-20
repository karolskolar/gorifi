import { expect } from '@playwright/test'

// ONE HOME for "the friend portal is (not) on screen" — 18 §UC-PI-019 item 1.
//
// ⚠ WHY THIS FILE EXISTS. Until PI-T1 every spec that needed to wait for the
// authenticated portal did it with
//
//     await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
//
// — a gate tied to the COPY of one screen's heading, repeated 72 times across 30
// files. Module 18 retires that screen (§UC-PI-005: the landing becomes the order
// grid and the cycle list is gone), so the gate had to move before the structure
// did. Putting it here means the NEXT information-architecture change edits one
// file instead of thirty, which is the whole point; a spec that hand-rolls
// `getByTestId('portal-landing')` inline is re-creating the problem.
//
// ⚠ WHY THIS LIVES OUTSIDE `tests/`. `playwright.config.js` sets
// `testDir: './tests'`, so a module here is imported by specs and never collected
// as one (a file under `tests/` with no `test()` in it fails the run outright) —
// the `copy-sweep.js` / `qr-pixels.js` precedent.
//
// ── WHAT THE MARKER IS, AND WHAT IT IS NOT ───────────────────────────────────
// `data-testid="portal-landing"` sits on `FriendPortalSession.vue`'s page column
// — the session's only unconditional element, rendered in all four views
// (`shop` | `history` | `balance` | `explainer`) and all three landing states
// (`open` | `locked` | `closed`). So it means exactly "a friend is signed in and
// their session is mounted", which is what all 72 call sites actually wanted.
//
// ⚠ It does NOT mean "the cycles have loaded" or "this particular view has
// rendered its body". A spec that needs either must assert THAT, beside this —
// the heading it replaces did not carry those claims either (it rendered above
// the list, empty or not), so nothing is weakened by saying so out loud.
//
// ── THE DRAWER HALF (PI-T2) ──────────────────────────────────────────────────
// `openMenu` / `menuGo` / `logout` / `openProfile` / `openInvite` landed with the
// hamburger drawer (18 §UC-PI-004). They are HERE, in the same file, on the same
// argument: the logout control alone had ~26 call sites across five spec files
// before PI-T2 moved it from an appbar glyph into the drawer footer, and the next
// IA change must edit one file rather than five.
//
// ⚠ THE DRAWER IS A `role="dialog"`, MOUNTED WITH `v-if`. 28 spec files resolve
// `getByRole('dialog')`; the drawer is in the DOM only while it is open, so none
// of them became ambiguous. The corollary binds every future spec: a test that
// counts dialogs while the menu is open is counting the menu too, and must open
// it deliberately.

/** The `data-testid` on `FriendPortalSession.vue`'s page column. One spelling. */
export const LANDING = 'portal-landing'

/**
 * The portal is on screen: a friend is signed in and the session is mounted.
 * The retarget of every `heading: 'Objednávkové cykly'` … `toBeVisible()` gate.
 */
export async function expectLanding(page) {
  await expect(page.getByTestId(LANDING)).toBeVisible()
}

/**
 * The portal is NOT on screen — the logout / lapsed-session claim.
 *
 * ⚠ `toHaveCount(0)`, not `not.toBeVisible()`: the session component is unmounted
 * by the parent's `v-if`, so the element is GONE rather than hidden, and a
 * count-0 assertion is the one that would red if a future change merely hid it
 * (leaving the previous friend's data mounted — the six-leak class this
 * component's boundary exists to prevent, `portal-session-boundary.spec.js`).
 */
export async function expectNoLanding(page) {
  await expect(page.getByTestId(LANDING)).toHaveCount(0)
}

/** The drawer itself, once open. Scope every menu locator to it. */
export function drawer(page) {
  return page.getByRole('dialog', { name: 'Menu' })
}

/**
 * Open the hamburger drawer and wait for it.
 *
 * ⚠ The appbar button is matched by its `aria-label`, not by a glyph or a class:
 * `.p2-icobtn` is shared with the explainer's back chevron (§UC-PI-003 `#leading`
 * renders one or the other), so a class locator would silently resolve to "the
 * control that happens to be there" on `/ako-to-funguje` — where there is no menu
 * at all.
 */
export async function openMenu(page) {
  await page.locator('.appbar [aria-label="Menu"]').click()
  await expect(drawer(page)).toBeVisible()
  return drawer(page)
}

/**
 * The friend's name as the CHROME renders it.
 *
 * ⚠ THE RETARGET OF `expect(page.locator('.appbar')).toContainText(name)` and of
 * `.appbar .titles .s` — 18 §UC-PI-003 moved the friend's `name` out of the appbar
 * (whose `.s` line is now a fixed per-view subtitle) into the DRAWER HEADER, which
 * is the ONLY place a friend's identity renders. THIRTEEN shipped assertions across
 * five files made that claim — in two shapes, `.appbar .titles .s` toHaveText and
 * `expect(page.locator('.appbar')).toContainText(name)`, the second invisible to a
 * grep for the first. They make it here now, once.
 *
 * ⚠ Call sites: google-auth ×7, portal-shell ×2, portal-profile-modal ×2,
 * portal-appbar ×1, magic-link ×1.
 *
 * It opens the drawer and closes it again, so the page is left as it was found and
 * `getByRole('dialog')` goes back to whatever it was — a caller that asserts dialog
 * counts afterwards is not counting a menu this helper forgot to close.
 *
 * ⚠ IT NEEDS THE MODAL LAYER FREE. The hamburger sits behind any open NeoModal's
 * scrim, so a call site with a dialog up (the Google link prompt, the forced-change
 * gate) cannot use this and must assert identity another way — the stored session's
 * `friendName` is the honest fallback there, and it is a weaker claim: it says whose
 * session this is, not whose name is painted.
 */
export async function expectChromeName(page, name) {
  const wasOpen = await drawer(page).count()
  if (!wasOpen) await openMenu(page)
  await expect(page.getByTestId('drawer-friend-name')).toHaveText(name)
  if (!wasOpen) {
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)
  }
}

/**
 * Open the menu and choose a row by its visible label.
 *
 * The row is a `role="button"` whose accessible name is its label plus its
 * sub-line, and Playwright matches a role name as a case-insensitive SUBSTRING
 * unless `exact: true` — which is exactly what makes „Moje objednávky" resolve a
 * row whose full name is „Moje objednávky 3 objednávky · naposledy …". Scoped to
 * the drawer, because „Pozvať priateľa" would otherwise also see the appbar's
 * „Pozvať" chip.
 */
export async function menuGo(page, label) {
  const menu = await openMenu(page)
  await menu.getByRole('button', { name: label }).click()
  // Every row closes the drawer first and then acts (§UC-PI-004), so waiting for
  // it to go is waiting for the action to have been dispatched.
  await expect(drawer(page)).toHaveCount(0)
}

/**
 * Log out through the drawer footer — the retarget of
 * `.appbar span[aria-label="Odhlásiť sa"]` and of
 * `getByRole('button', { name: 'Odhlásiť sa' })` (§UC-PI-019 item 4).
 *
 * ⚠ It asserts the outcome, not just the click: the wordmark is back (the appbar
 * survived the state change — it is ONE instance across all three auth states)
 * and the session is UNMOUNTED, not merely hidden. Those two assertions were in
 * most of the call sites it replaces; keeping them here is what stops the
 * retarget from weakening them.
 */
export async function logout(page) {
  const menu = await openMenu(page)
  await menu.getByRole('button', { name: 'Odhlásiť sa' }).click()
  await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
  await expectNoLanding(page)
}

/**
 * Open the profile modal — the retarget of `.appbar .titles` clicks
 * (§UC-PI-019 item 5). `.titles` has no action at all any more (§UC-PI-003).
 */
export async function openProfile(page) {
  await menuGo(page, 'Profil')
  await expect(page.getByRole('dialog').locator('.m-title')).toHaveText('Upraviť profil')
}

/**
 * Open the invite modal from the appbar chip. The chip STAYS in the appbar
 * (roadmap §16 / Q2.a), so this locator is unchanged from module 03 — the helper
 * exists so that the drawer's „Pozvať priateľa" row and the chip have one named
 * entry point each rather than an inline locator per call site.
 */
export async function openInvite(page) {
  await page.locator('.appbar .chip.acc').click()
  await expect(page.getByRole('dialog').locator('.m-title')).toHaveText('Pozvi priateľa')
}

/**
 * Open a cycle's own order screen (`/cycle/:id`, `FriendOrder` in `mode='route'`) —
 * 18 §UC-PI-019 item 3.
 *
 * ⚠ THE RETARGET OF `page.goto('/')` + `getByRole('heading', { name: cycle.name,
 * exact: true }).click()`. That pair was how TWENTY spec files reached an order
 * screen, because a cycle card on the portal was the only in-app route to one.
 * PI-T3 retires the cards (§UC-PI-005), so the navigation moved here — one home, the
 * same argument as `expectLanding` itself.
 *
 * ⚠ AND IT IS NOT A PLAIN `page.goto('/cycle/:id')`, although §UC-PI-019 item 3
 * writes it that way. The friend's Bearer token lives in MEMORY only
 * (`api.js setFriendsToken`); `localStorage` holds the stored session, and
 * `FriendPortal.vue` is the single owner that restores one. So a cold document load
 * of `/cycle/:id` finds no credential and bounces to `/` by design — the shipped
 * behaviour every one of those twenty files was working around.
 *
 * What this does instead uses that bounce rather than fighting it:
 *   1. `goto('/cycle/:id')` — the app bounces with `router.push('/')`, which is a
 *      same-document `pushState`, so the history is now [/cycle/:id, /];
 *   2. wait for the portal — that is the session restoring the token into memory;
 *   3. `goBack()` — a same-document traversal back to entry 1, handled by
 *      vue-router as a client-side navigation. `FriendOrder` mounts with the
 *      credential already in memory and does not bounce.
 * No app change, no new auth path, and the URL assertion is the shipped one.
 *
 * ⚠ It needs a STORED session (`localStorage.gorifi_friend_auth`) — every caller
 * seeds one in an `addInitScript`. Without it step 2 fails on the login card, which
 * is the honest failure.
 */
export async function gotoCycle(page, cycleId) {
  await page.goto(`/cycle/${cycleId}`)
  await expectLanding(page)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycleId}(?:[?#]|$)`))
}
