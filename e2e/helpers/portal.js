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
// ── WHAT IS DELIBERATELY NOT HERE YET ────────────────────────────────────────
// §UC-PI-019 item 1 also names `openMenu`, `menuGo`, `logout`, `openProfile` and
// `openInvite`. Every one of them drives the hamburger DRAWER, which PI-T2 builds;
// written now they would be helpers no test can call and nobody can prove. PI-T2
// adds them HERE, to this file, and retargets the logout/profile call sites onto
// them (§UC-PI-019 items 4, 5).

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
