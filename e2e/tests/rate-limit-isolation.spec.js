import { test, expect } from '@playwright/test'

// The guest surface (/api/guest) has its OWN rate-limit buckets, deliberately
// separate from the `abuseLimiter` that guards the invite-code lookup and the
// onboarding submit — and its reads are separate from its writes.
//
// Why this matters: a guest link is shared privately at office scale, so a whole
// team typically arrives behind ONE NAT'd IP. While the guest routes sat on the
// shared bucket, a busy order could exhaust it and lock colleagues out of
// registering (and vice versa) — the exact audience the feature is for.
//
// Like rate-limit.spec.js, this is only meaningful against a server started with
// a LOW guest write limit, e.g.
//   RATE_LIMIT_GUEST_WRITE_MAX=3 RATE_LIMIT_ABUSE_MAX=40 node backend/src/index.js
// Guarded so a normally-configured full-suite run skips it instead of burning
// budget it shares with nothing.
const GUEST_WRITE_MAX = parseInt(process.env.RATE_LIMIT_GUEST_WRITE_MAX || '', 10)
const ABUSE_MAX = parseInt(process.env.RATE_LIMIT_ABUSE_MAX || '', 10)

test.describe('Rate-limit bucket isolation (guest surface)', () => {
  test.skip(
    !(GUEST_WRITE_MAX > 0 && GUEST_WRITE_MAX <= 10 && (!ABUSE_MAX || ABUSE_MAX > 10)),
    'run with a low RATE_LIMIT_GUEST_WRITE_MAX (<=10) and a normal RATE_LIMIT_ABUSE_MAX to exercise isolation'
  )

  test('exhausting the guest WRITE budget leaves guest reads and the invitations surface working', async ({ request }) => {
    // An unknown token 404s before any real work, so this exercises the limiter
    // without creating data or depending on a seeded link.
    const write = () =>
      request.post('/api/guest/NOSUCHTOKEN/orders', { data: { items: [] } })

    const statuses = []
    for (let i = 0; i < GUEST_WRITE_MAX + 3; i++) {
      statuses.push((await write()).status())
    }

    expect(statuses[0], 'first guest write should reach the handler (404), not be blocked').toBe(404)
    expect(statuses.some((s) => s === 429), 'guest write limiter should engage past its max').toBe(true)
    expect(statuses[statuses.length - 1], 'well past the max, guest writes are blocked').toBe(429)

    // The three assertions that make this spec worth having: none of the other
    // buckets were touched by exhausting the guest WRITE one.
    const guestRead = await request.get('/api/guest/NOSUCHTOKEN')
    expect(guestRead.status(), 'guest READ bucket is separate from guest WRITE').toBe(404)

    const inviteLookup = await request.get('/api/invitations/code/ZZZZZZZZ')
    expect(inviteLookup.status(), 'invite-code lookup (abuseLimiter) is a separate bucket').toBe(404)

    const inviteRegister = await request.post('/api/invitations/register', {
      data: { invite_code: 'ZZZZZZZZ', name: 'Izolacia Test', phone: '123456789' },
    })
    expect(
      inviteRegister.status(),
      'registration still reaches its handler (400 invalid code), i.e. is not 429'
    ).toBe(400)
  })
})
