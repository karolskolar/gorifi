import { test, expect } from '@playwright/test'

// Smoke tests for the public-facing surfaces — these must keep working after
// the Phase 1 lockdown (no regression for legitimate anonymous users).

test.describe('Public surfaces', () => {
  test('friend portal loads at / and shows the login card', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/Podpultovka/)
    // Legacy/modern both render a "Prihlásenie" login card for anonymous users.
    await expect(page.getByText('Prihlásenie')).toBeVisible()
  })

  // The tab identity. Both halves regressed in production before: the title
  // shipped as the Vite scaffold's literal "frontend" and the icon as `vite.svg`,
  // the scaffold triangle, for months. `/favicon.svg` is the brand monogram
  // imported from the design project.
  //
  // ⚠ The link is asserted AND the file is FETCHED. A `<link>` pointing at a path
  // that 404s renders exactly like no favicon at all, and neither the DOM
  // assertion nor a screenshot would show it — browsers request the icon out of
  // band, so it never appears in a page-load network sweep either.
  test('the favicon is the brand monogram, and it actually resolves', async ({ page, request }) => {
    await page.goto('/')
    const icon = page.locator('link[rel="icon"]')
    await expect(icon).toHaveCount(1)
    await expect(icon).toHaveAttribute('href', '/favicon.svg')
    await expect(icon).toHaveAttribute('type', 'image/svg+xml')

    const res = await request.get('/favicon.svg')
    expect(res.status(), '/favicon.svg must be served').toBe(200)
    expect(res.headers()['content-type']).toContain('image/svg+xml')
    const svg = await res.text()
    // The two brand tokens, so a placeholder icon cannot pass: ink #0a0a0a plate,
    // accent #ff2d87 monogram (friends-theme.css `--nb-ink` / `--accent`).
    expect(svg).toContain('#0a0a0a')
    expect(svg).toContain('#ff2d87')
  })

  test('admin login page loads at /admin', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.locator('#password')).toBeVisible()
    await expect(page.getByRole('button', { name: /Prihlásiť sa|Nastaviť heslo/ })).toBeVisible()
  })

  test('the SPA fallback serves index.html for a deep link', async ({ page }) => {
    // A non-API deep link should still return the SPA (not a 404).
    const res = await page.goto('/cycle/999999')
    expect(res.status()).toBeLessThan(400)
    await expect(page).toHaveTitle(/Podpultovka/)
  })
})
