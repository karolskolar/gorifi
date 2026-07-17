import { test, expect } from '@playwright/test'
import { ADMIN_PASSWORD, CYCLE_NAME } from '../fixtures.js'

// UI assertions for the frontend admin auth: the router guard, login flow,
// data loading (proves the admin token is sent), and logout.

test.describe('Admin auth — UI', () => {
  test('unauthenticated visit to an admin page redirects to login', async ({ page }) => {
    await page.context().clearCookies()
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/admin/dashboard')
    // The beforeEach guard redirects to /admin (login).
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.locator('#password')).toBeVisible()
  })

  test('login with a wrong password shows an error and stays on login', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/admin')
    await page.locator('#password').fill('definitely-wrong-password')
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    // Backend returns "Nespravne heslo" (no diacritics); match either form.
    await expect(page.getByText(/Nespr[aá]vne heslo|Chyba/)).toBeVisible()
    await expect(page).toHaveURL(/\/admin$/)
  })

  test('login with the correct password reaches the dashboard and loads data', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()

    await expect(page).toHaveURL(/\/admin\/dashboard/)
    await expect(page.getByRole('heading', { name: 'Gorifi - Admin' })).toBeVisible()
    // Data loading through the admin token: the seeded cycle should render.
    await expect(page.getByText(CYCLE_NAME, { exact: false })).toBeVisible()
  })

  test('logout clears the session and re-protects admin pages', async ({ page }) => {
    // Log in first.
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)

    // Log out.
    await page.getByRole('button', { name: /Odhlásiť sa/ }).first().click()
    await expect(page).toHaveURL(/\/admin$/)

    // The token is gone — visiting an admin page redirects to login again.
    await page.goto('/admin/friends')
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.locator('#password')).toBeVisible()
  })
})
