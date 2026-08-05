import { test, expect } from '@playwright/test'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD, CYCLE_NAME } from '../fixtures.js'

// The friend order page must never make the DOCUMENT scroll sideways on a phone.
// When it does, the page can be scrolled off-centre and content is clipped off the
// LEFT edge — reported from production as a clipped header, a sliced "Espresso" tab
// and a missing "250g" label.
//
// Root cause was the purpose tab strip: every TabsTrigger is `whitespace-nowrap`,
// so with several purposes the strip's min-content width exceeds the viewport and
// the `inline-flex` widened the document instead of scrolling inside itself
// (measured: 46px of overflow at 390px with five tabs). Fixed in
// components/ui/tabs/TabsList.vue with `max-w-full overflow-x-auto`.
//
// This asserts the invariant rather than the implementation: documentElement
// .scrollWidth must equal clientWidth. Elements are allowed to extend past the
// viewport INSIDE their own scrollable container — that is the whole point of the
// fix — so only the document is measured.

const PURPOSES = ['Espresso', 'Filter', 'Brew Bags', 'Filter Special', 'Nespresso']
const VIEWPORTS = [320, 390]

test.describe('Mobile layout — no horizontal document overflow', () => {
  let cycleId
  let friend
  let session

  test.beforeAll(async ({ request }) => {
    const login = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status()).toBe(200)
    const admin = { 'X-Admin-Token': (await login.json()).token }

    const cycles = await (await request.get('/api/cycles', { headers: admin })).json()
    cycleId = cycles.find((c) => c.name === CYCLE_NAME).id

    // Enough purposes that the tab strip cannot fit a phone viewport, plus the long
    // name + nowrap badges that squeezed the title column in the original report.
    for (const [i, purpose] of PURPOSES.entries()) {
      await request.post('/api/products', {
        headers: admin,
        data: {
          cycle_id: cycleId,
          name: 'Brazil Morada da Prata Natural',
          purpose,
          roast_type: i === 0 ? 'Medium roast' : 'Medium & Full city roast',
          roastery: 'Goriffee',
          description1: '100% natural bourbon arabica',
          price_250g: 9.04,
          price_1kg: 35.7,
        },
      })
    }

    const friends = await (await request.get('/api/friends?active=true', { headers: admin })).json()
    friend = friends[0]
    session = await (await request.post('/api/friends/auth', {
      data: { password: FRIENDS_PASSWORD, friendId: friend.id },
    })).json()
  })

  for (const width of VIEWPORTS) {
    test(`the friend order page does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.addInitScript(([f, s]) => {
        localStorage.setItem('gorifi_friend_auth', JSON.stringify({
          friendId: f.id, friendName: f.name, token: s.token, expiresAt: s.expiresAt,
        }))
      }, [friend, session])

      // A hard load of /cycle/:id bounces to the portal (FriendOrder defers auth
      // restore to FriendPortal), so enter the way a real user does.
      await page.goto('/')
      await page.getByText(CYCLE_NAME, { exact: false }).first().click()
      await page.waitForURL(/\/cycle\//)

      // The tab strip must actually be rendered, or this would pass vacuously.
      // Scope to the strip: an unscoped role=tab lookup can match more than one
      // element on this page and trip strict mode for reasons unrelated to layout.
      const strip = page.getByRole('tablist').first()
      await expect(strip).toBeVisible()
      // A floor, not an exact count: other specs add purposes to this shared
      // seeded cycle, and more tabs only means MORE overflow pressure — so an
      // exact count would be brittle without making the test any stronger.
      const tabCount = await strip.getByRole('tab').count()
      expect(tabCount, 'enough purpose tabs to overflow a phone viewport')
        .toBeGreaterThanOrEqual(PURPOSES.length)

      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(
        metrics.scrollWidth,
        `document must not overflow horizontally (overflow ${metrics.scrollWidth - metrics.clientWidth}px)`
      ).toBe(metrics.clientWidth)

      // And the strip itself is the thing that scrolls, so the tabs stay reachable.
      const scrollable = await strip.evaluate((el) => el.scrollWidth > el.clientWidth)
      expect(scrollable, 'the tab strip should scroll within itself').toBe(true)
    })
  }
})
