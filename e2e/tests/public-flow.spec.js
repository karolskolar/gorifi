import { test, expect } from '@playwright/test'

// Smoke tests for the public-facing surfaces — these must keep working after
// the Phase 1 lockdown (no regression for legitimate anonymous users).

test.describe('Public surfaces', () => {
  test('friend portal loads at / and shows the login card', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/Gorifi/)
    // Legacy/modern both render a "Prihlásenie" login card for anonymous users.
    await expect(page.getByText('Prihlásenie')).toBeVisible()
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
    await expect(page).toHaveTitle(/Gorifi/)
  })
})
