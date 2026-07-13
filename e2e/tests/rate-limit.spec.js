import { test, expect } from '@playwright/test'

// SEC-F2 (audit §H2): auth endpoints are rate-limited. This spec is meaningful
// only when the server under test was started with a LOW limit, e.g.
//   RATE_LIMIT_AUTH_MAX=3 node backend/src/index.js
// Run it against a dedicated low-limit server so it doesn't trip the limiter
// for the rest of the suite (which runs against a normally-configured server).
//
// Guarded: if RATE_LIMIT_AUTH_MAX isn't set low, skip rather than hammer a
// production-limit endpoint hundreds of times.
const MAX = parseInt(process.env.RATE_LIMIT_AUTH_MAX || '', 10)

test.describe('Rate limiting (SEC-F2)', () => {
  test.skip(!(MAX > 0 && MAX <= 10), 'run with a low RATE_LIMIT_AUTH_MAX (<=10) to exercise the limiter')

  test('admin login returns 429 after the configured attempt limit', async ({ request }) => {
    const attempt = () =>
      request.post('/api/admin/login', { data: { password: 'definitely-wrong' } })

    // Hammer well past the limit. (Prior calls — e.g. the seed's admin login —
    // may have consumed part of the budget, so assert on shape, not exact index.)
    const statuses = []
    for (let i = 0; i < MAX + 6; i++) {
      statuses.push((await attempt()).status())
    }

    // A normal (first) request is processed, not blocked outright.
    expect(statuses[0], 'first request should not be rate-limited').not.toBe(429)
    // The limiter kicks in once the window budget is exhausted.
    expect(statuses.some((s) => s === 429), 'limiter should return 429 after the max').toBe(true)
    // Well past the limit, requests are definitively blocked.
    expect(statuses[statuses.length - 1]).toBe(429)
  })
})
