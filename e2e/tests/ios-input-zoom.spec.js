import { test, expect, devices, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// A12 — mobile Safari must not zoom the viewport when a field is focused.
//
// REPORTED FROM PRODUCTION (2026-08-12): after logging in on iOS the whole app
// stayed magnified — the appbar's "Pozvať" chip and the logout glyph clipped off
// the right edge, the ticker cut mid-word, the cycle-list gear unreachable — on
// every screen, until the user pinched back out by hand.
//
// Mechanism: mobile Safari zooms IN when a text control whose computed font-size is
// under 16px receives focus, and it does not zoom back out on blur. The canon's
// `.inp` is 15px — one pixel inside the trigger — so a single tap in the login
// field re-scaled the rest of the session.
//
// ⚠ This CANNOT be reproduced in this suite: no engine here implements the zoom
// (it is a mobile-Safari behaviour, and the gate runs Chromium). What is testable is
// the CONDITION the behaviour keys on — the computed font-size on a coarse-pointer
// device — and that is what every assertion below measures. A test that tried to
// observe `visualViewport.scale` changing would be silently vacuous.

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// ⚠ `defaultBrowserType` must be stripped from the device descriptor: `iPhone 13`
// carries `'webkit'`, and setting it inside a `describe` is a hard Playwright error
// ("forces a new worker"). What this spec actually needs from the descriptor is the
// viewport plus `hasTouch`/`isMobile`, which is what produces `pointer: coarse` —
// the condition under test. The engine is irrelevant here precisely because no
// engine in this suite implements the zoom itself.
const { defaultBrowserType, ...IPHONE } = devices['iPhone 13']

// The threshold is exactly 16: 15.99px zooms, 16px does not.
const IOS_ZOOM_THRESHOLD = 16

let ctx = null
let inviteCode = ''

// A public route with real, unauthenticated `.inp` fields. `/invite/:code` needs a
// valid code (a bad one renders the field-less invalid card), and `friends.js`
// strips `invite_code` from every friend response, so `GET /invitations/my-code` on
// a friend Bearer session is the only route to one — same idiom as
// invite-register-shell.spec.js.
test.beforeAll(async ({ baseURL }) => {
  ctx = await playwrightRequest.newContext({ baseURL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  const adminToken = (await login.json()).token
  const admin = (p, o = {}) => ctx[o.method || 'get'](p, {
    headers: { 'X-Admin-Token': adminToken },
    ...(o.data ? { data: o.data } : {}),
  })

  const username = `ioszoom_${uniq}`.slice(0, 30)
  const created = await admin('/api/friends', { method: 'post', data: { name: `E2E iOS Zoom ${uniq}` } })
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

/** Computed font-size of every rendered `.inp`, plus the media-query state. */
async function inputMetrics(page) {
  return page.evaluate(() => ({
    coarse: matchMedia('(pointer: coarse)').matches,
    inputs: Array.from(document.querySelectorAll('.inp')).map((el) => ({
      id: el.id || el.getAttribute('type') || el.tagName.toLowerCase(),
      fontSize: parseFloat(getComputedStyle(el).fontSize),
    })),
  }))
}

test.describe('A12 — no iOS focus-zoom on any friend/guest field', () => {
  test.describe('on a phone (coarse pointer)', () => {
    test.use({ ...IPHONE })

    test('every rendered `.inp` computes at least 16px', async ({ page }) => {
      await page.goto(`/invite/${inviteCode}`)
      await expect(page.getByTestId('invite-form')).toBeVisible()

      const m = await inputMetrics(page)
      // Non-vacuity, both halves: the gate must really be a coarse pointer, and
      // there must really be fields on screen.
      expect(m.coarse, 'the emulated device must report pointer: coarse').toBe(true)
      // 07 §UC-IA-008 item 4: 3 → 4, the mandated optional username field
      // (§UC-IA-004). This is a NON-VACUITY gate, so it must track the real field
      // count — the loop below would pass on an empty list.
      expect(m.inputs.length, 'no .inp rendered — the assertion below would be empty').toBe(4)

      for (const input of m.inputs) {
        expect(input.fontSize, `${input.id} would trigger iOS zoom at ${input.fontSize}px`)
          .toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD)
      }
    })

    // `.inp.mono` is (0,2,0) against `.inp`'s (0,1,0) — `:where()` contributes
    // nothing — so the A12 block needs its own line for it or it keeps 13px. It has
    // no call site today, which is exactly why it is probed synthetically: the rule
    // must already be right when the next mono field is written.
    test('a synthesized `.inp.mono` is covered too (it has no call site yet)', async ({ page }) => {
      await page.goto(`/invite/${inviteCode}`)
      await expect(page.getByTestId('invite-form')).toBeVisible()

      const sizes = await page.evaluate(() => {
        const app = document.querySelector('.app')
        const mk = (cls) => {
          const el = document.createElement('input')
          el.className = cls
          app.appendChild(el)
          const fs = parseFloat(getComputedStyle(el).fontSize)
          el.remove()
          return fs
        }
        return { plain: mk('inp'), mono: mk('inp mono') }
      })
      expect(sizes.plain).toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD)
      expect(sizes.mono, '.inp.mono outranks .inp and needs its own A12 line')
        .toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD)
    })

    // ⚠ The fix that must NOT be used. `maximum-scale=1` / `user-scalable=no` also
    // stops the zoom — by removing pinch-zoom for everyone, a WCAG 1.4.4 failure, on
    // the one screen where someone with poor eyesight most needs to magnify (a
    // password they cannot read). If a future "fix" takes that shortcut, this fails.
    test('the viewport meta does not disable pinch-zoom', async ({ page }) => {
      await page.goto(`/invite/${inviteCode}`)
      const content = await page.locator('meta[name="viewport"]').getAttribute('content')
      expect(content).toBeTruthy()
      expect(content, 'user-scalable=no is not an acceptable fix').not.toMatch(/user-scalable\s*=\s*(no|0)/i)
      expect(content, 'maximum-scale caps pinch-zoom').not.toMatch(/maximum-scale/i)
    })
  })

  test.describe('on a desktop (fine pointer)', () => {
    test.use({ viewport: { width: 1280, height: 800 } })

    // The deviation is deliberately scoped: the canon's 15px is what desktop shows,
    // because the bug cannot occur there. If A12 is ever widened to an unconditional
    // rule, this is what says so.
    test('the canon 15px is untouched where the bug cannot happen', async ({ page }) => {
      await page.goto(`/invite/${inviteCode}`)
      await expect(page.getByTestId('invite-form')).toBeVisible()

      const m = await inputMetrics(page)
      expect(m.coarse, 'desktop must not match pointer: coarse').toBe(false)
      // 07 §UC-IA-008 item 4 — same 3 → 4 as the coarse-pointer test above.
      expect(m.inputs.length).toBe(4)
      for (const input of m.inputs) {
        expect(input.fontSize, `${input.id} should keep the canon 15px on desktop`).toBe(15)
      }
    })
  })
})
