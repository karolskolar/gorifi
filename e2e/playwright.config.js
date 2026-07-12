import { defineConfig, devices } from '@playwright/test'

// Target-agnostic: point at any deployment with BASE_URL.
//   local prod-like : BASE_URL=http://localhost:3997
//   staging         : BASE_URL=https://gorifi-dev.skolar.sk
const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Staging serves over TLS with a real cert; keep strict. Flip via env if needed.
    ignoreHTTPSErrors: process.env.IGNORE_HTTPS === '1',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
