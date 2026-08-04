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
