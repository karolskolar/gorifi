import { test, expect } from '@playwright/test'
import { FRIEND_NAME } from '../fixtures.js'

// Hotfix regression tests: the friend portal login page must never depend on
// the admin-only GET /friends. In legacy/transition mode the dropdown is fed
// by the public minimal /friends/login-list; in modern mode no list is needed.
// (Regression: Promise.all([authMode, adminList]) rejected for anonymous
// visitors, leaving authMode stuck on 'legacy' with an empty dropdown.)

test.describe('public login list', () => {
  test('login-list is public and minimal (legacy seed)', async ({ request }) => {
    const res = await request.get('/api/friends/login-list')
    expect(res.status()).toBe(200)
    const list = await res.json()
    expect(Array.isArray(list)).toBe(true)

    const tester = list.find(f => f.name === FRIEND_NAME)
    expect(tester).toBeTruthy()
    expect(typeof tester.id).toBe('number')
    expect(typeof tester.hasCredentials).toBe('boolean')

    // Strictly minimal payload — nothing an admin list would carry.
    //
    // ⚠ FUP-T17 reviewed this exact-key-set sweep and DELIBERATELY LEFT IT AS IS.
    // It looks like the whole-database defect FUP-T16 fixed, and it is not:
    //  • FUP-T16's rule is "a VALUE claim over an unbounded set is a latent flake, a
    //    SHAPE claim over the same set is legitimately global — do not narrow those."
    //    `Object.keys(f).sort()` is a SHAPE claim. It also cannot be broken by another
    //    spec creating a friend: every row here is built by ONE `.map()` in
    //    `friends.js`, so this is an invariant of the ENDPOINT, not of the database
    //    contents. Row-scoping it to `tester` would weaken it for nothing.
    //  • The strictness is the point. `/api/friends/login-list` is the app's only
    //    PUBLIC, UNAUTHENTICATED endpoint that enumerates real people (03 §UC-FL-003:
    //    "id + name + hasCredentials only"). A denylist regex catches
    //    `password_hash`/`invite_code`; only an exact key set catches a `SELECT *`
    //    widening or a well-meant new field (phone, e-mail, balance, a Google hint).
    //
    // ⚠ MODULE 10, READ THIS BEFORE "FIXING" A RED HERE. If a Google hint is ever
    // added to this payload, it publishes a per-friend linked/unlinked oracle to
    // anonymous visitors for EVERY friend at once — a strictly worse version of the
    // `not_linked` login-hint oracle 10 §Accepted risks already flags for a single
    // probed account. And it should not arise: Google login is modern-mode only
    // (10 resolved decision #2) while this route returns `[]` in modern mode, so the
    // Google path never reads it. Forcing that to be an EXPLICIT decision — spec
    // amendment + this line — rather than a silently-widened public payload is
    // exactly what this assertion is for. Widen it only together with the module 10
    // spec section that mandates the new key.
    for (const f of list) {
      expect(Object.keys(f).sort()).toEqual(['hasCredentials', 'id', 'name'])
    }
  })

  test('full friends list stays admin-only', async ({ request }) => {
    const res = await request.get('/api/friends?active=true')
    expect(res.status()).toBe(401)
  })

  test('own profile endpoint rejects anonymous access', async ({ request }) => {
    const res = await request.get('/api/friends/1/profile')
    expect([401, 403]).toContain(res.status())
  })
})

test.describe('login page renders without admin data', () => {
  test('legacy login shows a populated name dropdown', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Prihlásenie')).toBeVisible()
    // Legacy/transition UI: the name select trigger is present (no error state)
    const trigger = page.getByRole('combobox')
    await expect(trigger).toBeVisible()
    // The dropdown actually has options — the regression left it empty.
    await trigger.click()
    await expect(page.getByRole('option', { name: FRIEND_NAME })).toBeVisible()
  })
})
