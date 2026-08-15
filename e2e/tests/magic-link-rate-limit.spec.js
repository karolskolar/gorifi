// ML-T2 — the FIFTH rate-limit bucket, `magicLinkLimiter` (09 §UC-ML-003 §Rate
// limiting; §UC-ML-010 obligation 5).
//
// Why magic-link recovery does not share `authLimiter`, restated so a future
// "simplification" has to argue with a test:
//
//   (a) COST PROFILE. An accepted request triggers an outbound Mailgun send. No other
//       bucket guards an endpoint that spends money and sender reputation per hit, so
//       its budget is set independently (default 10/window against authLimiter's 20).
//   (b) OFFICE NAT — the same coupling that forced the guest read/write split
//       (CLAUDE.md §Rate-limit buckets). A whole team arrives behind ONE IP. On a
//       shared bucket, one colleague spamming "Zabudli ste heslo?" would lock everyone
//       else out of PASSWORD LOGIN — precisely when they need it — and a busy login
//       morning would silently disable recovery.
//
// Like `rate-limit.spec.js` and `rate-limit-isolation.spec.js`, this is only meaningful
// against a server started with a LOW magic-link limit, e.g.
//   RATE_LIMIT_MAGIC_MAX=3 RATE_LIMIT_AUTH_MAX=20 node backend/src/index.js
// so a normally-configured full-suite run SKIPS it rather than burning a budget it
// shares with nothing.

import { test, expect } from '@playwright/test'
import { FRIENDS_PASSWORD } from '../fixtures.js'

const MAGIC_MAX = parseInt(process.env.RATE_LIMIT_MAGIC_MAX || '', 10)
const AUTH_MAX = parseInt(process.env.RATE_LIMIT_AUTH_MAX || '', 10)
const ABUSE_MAX = parseInt(process.env.RATE_LIMIT_ABUSE_MAX || '', 10)

test.describe('Rate-limit bucket isolation (magic-link recovery)', () => {
  test.skip(
    !(MAGIC_MAX > 0 && MAGIC_MAX <= 10 && (!AUTH_MAX || AUTH_MAX > 10)),
    'run with a low RATE_LIMIT_MAGIC_MAX (<=10) and a normal RATE_LIMIT_AUTH_MAX to exercise isolation'
  )

  test('exhausting the magic-link budget leaves password login and the invite surface working', async ({ request }) => {
    // An identifier that matches nothing still reaches the handler and still costs a
    // token from the bucket — no fixture, no mail, no data created.
    const ask = () => request.post('/api/magic-link/request', { data: { identifier: 'nobody-rl@example.test' } })

    const statuses = []
    for (let i = 0; i < MAGIC_MAX + 3; i++) {
      statuses.push((await ask()).status())
    }

    expect(statuses[0], 'the first request should reach the handler (neutral 200), not be blocked').toBe(200)
    expect(statuses.at(-1), 'past the budget the limiter answers 429').toBe(429)
    expect(
      statuses.filter((s) => s === 429).length,
      'roughly the overflow is blocked — the bucket is real'
    ).toBeGreaterThanOrEqual(3)

    // ── (b): PASSWORD LOGIN is untouched ──────────────────────────────────────
    // 401 (bad credentials) is the handler answering; 429 would mean the limiter ate
    // it, i.e. the recovery spammer just locked the office out of logging in.
    const login = await request.post('/api/friends/auth', {
      data: { username: 'definitely-not-a-real-user', password: 'nope' },
    })
    expect(login.status(), 'password login still reaches its handler').not.toBe(429)
    expect([400, 401], 'a real auth answer, not a limiter answer').toContain(login.status())

    // The legacy shared-password branch of the same endpoint, likewise.
    const shared = await request.post('/api/friends/auth', { data: { password: FRIENDS_PASSWORD } })
    expect(shared.status(), 'the legacy auth branch still reaches its handler').not.toBe(429)

    // ── the abuse bucket (invite-code lookup / registration) is also untouched ──
    if (!ABUSE_MAX || ABUSE_MAX > 10) {
      const invite = await request.get('/api/invitations/code/NOSUCHCODE')
      expect(invite.status(), 'the invite-code lookup still reaches its handler').not.toBe(429)
    }
  })
})
