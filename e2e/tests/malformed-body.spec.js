import { test, expect } from '@playwright/test'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'

// FUP-T3 — `07 §Follow-ups item 1`.
//
// body-parser (`express.json`) rejects an unparsable or scalar body BEFORE any
// route runs, so the rejection lands straight in the global error handler in
// `backend/src/index.js`. That handler used to answer 500 unconditionally, which
// reported a pure client mistake as a server fault on EVERY JSON endpoint in the
// app — public, friend and admin alike.
//
// These assertions are deliberately spread over a public route (`/api/admin/login`),
// a second public route (`/api/friends/auth`) and an admin route (`POST /api/cycles`)
// because the handler sits underneath all of them: a fix that only worked on one
// mount would be indistinguishable from no fix at all on the others.
//
// The counter-assertions matter as much as the 400s: nothing that legitimately 500s
// may start reporting 400, a well-formed body must still reach its route (so the
// route's OWN validation message comes back, not the parser's), and the 413/415
// bodies must keep the status body-parser itself chose rather than being flattened
// to 400.

const JSON_HEADERS = { 'content-type': 'application/json' }

// `-d 'null'` and `-d '"hi"'` parse as valid JSON but are scalars; `express.json`
// runs in its default `strict` mode and rejects anything that is not an object or
// an array. The third body is plain broken JSON. All three are `entity.parse.failed`.
const BAD_BODIES = [
  { label: 'scalar null', body: 'null' },
  { label: 'scalar string', body: '"hi"' },
  { label: 'truncated object', body: '{"password":' },
  { label: 'not JSON at all', body: 'this is not json' },
]

// Public JSON endpoints — anyone on the internet can reach these, which is exactly
// why a malformed body must not read as "the server broke".
const PUBLIC_JSON_ROUTES = [
  { path: '/api/admin/login', label: 'admin login' },
  { path: '/api/friends/auth', label: 'friend auth' },
]

async function adminToken(request) {
  const login = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login should succeed with the seeded password').toBe(200)
  const { token } = await login.json()
  expect(token).toBeTruthy()
  return token
}

test.describe('Malformed JSON body — public routes answer 400, not 500', () => {
  for (const route of PUBLIC_JSON_ROUTES) {
    for (const bad of BAD_BODIES) {
      test(`POST ${route.path} with a ${bad.label} body is a 400`, async ({ request }) => {
        const res = await request.post(route.path, { headers: JSON_HEADERS, data: bad.body })
        expect(res.status(), `${route.label}: a client-side body error is not a server fault`).toBe(400)

        const json = await res.json()
        expect(typeof json.error, 'the 400 carries a Slovak error string').toBe('string')
        expect(json.error.length).toBeGreaterThan(0)
      })
    }
  }

  test('the 400 body leaks neither the parser message nor a stack trace', async ({ request }) => {
    const res = await request.post('/api/admin/login', { headers: JSON_HEADERS, data: '{"password":' })
    expect(res.status()).toBe(400)
    const raw = await res.text()

    // body-parser's own message names the position and echoes the input; a stack
    // names the file. Neither belongs in a response to an unauthenticated client.
    expect(raw, 'no parser internals').not.toMatch(/JSON|Unexpected|position|token/i)
    expect(raw, 'no stack trace').not.toMatch(/at .*\.js|node_modules|index\.js/)

    const json = JSON.parse(raw)
    expect(Object.keys(json), 'the payload is just an error string').toEqual(['error'])
  })
})

test.describe('Malformed JSON body — admin routes answer 400, not 500', () => {
  test('POST /api/cycles with a scalar body is a 400 for an authenticated admin', async ({ request }) => {
    const token = await adminToken(request)
    for (const bad of BAD_BODIES) {
      const res = await request.post('/api/cycles', {
        headers: { ...JSON_HEADERS, 'X-Admin-Token': token },
        data: bad.body,
      })
      expect(res.status(), `admin route, ${bad.label} body`).toBe(400)
    }
  })

  test('an anonymous malformed body on an admin route is a 400 (the parser runs before the guard)', async ({ request }) => {
    // Documented, deliberate: `express.json` is mounted above every router, so a
    // body it cannot parse never reaches `requireAdmin`. 400 here leaks nothing —
    // the same 400 comes back for an existent and a nonexistent admin route — and
    // api-security.spec.js's anonymous-401 census sends well-formed bodies, so the
    // authorization boundary it pins is untouched.
    const res = await request.post('/api/cycles', { headers: JSON_HEADERS, data: 'null' })
    expect(res.status()).toBe(400)
  })
})

test.describe('Malformed JSON body — nothing else moved', () => {
  test('a well-formed body still reaches the route: wrong admin password is still 401', async ({ request }) => {
    const res = await request.post('/api/admin/login', { data: { password: 'definitely-wrong-password' } })
    expect(res.status()).toBe(401)
    expect((await res.json()).error).toMatch(/Nespr[aá]vne heslo/)
  })

  test('a well-formed body still reaches the route: the correct admin password still mints a token', async ({ request }) => {
    const token = await adminToken(request)
    const res = await request.get('/api/friends', { headers: { 'X-Admin-Token': token } })
    expect(res.status(), 'the freshly minted token still works').toBe(200)
  })

  test('a well-formed body still reaches the route: friend auth still succeeds', async ({ request }) => {
    const res = await request.post('/api/friends/auth', { data: { password: FRIENDS_PASSWORD } })
    expect(res.status(), 'the seeded shared password still authenticates').toBe(200)
    expect((await res.json()).success).toBe(true)
  })

  test('a well-formed body still reaches the route: an admin POST keeps its OWN 400 and its OWN 201', async ({ request }) => {
    const token = await adminToken(request)
    const headers = { 'X-Admin-Token': token }

    // The route's own validation, not the parser's — the message proves which
    // layer answered.
    const missingName = await request.post('/api/cycles', { headers, data: {} })
    expect(missingName.status()).toBe(400)
    expect((await missingName.json()).error, 'this 400 came from the route, not the parser')
      .toMatch(/Nazov je povinny/)

    // And a genuinely valid admin POST still writes.
    const name = `FUP-T3 throwaway ${Date.now()}`
    const created = await request.post('/api/cycles', { headers, data: { name } })
    expect([200, 201]).toContain(created.status())
    const cycle = await created.json()
    expect(cycle.name).toBe(name)

    // Clean up so the shared e2e DB does not accumulate cycles.
    const del = await request.delete(`/api/cycles/${cycle.id}`, { headers })
    expect([200, 204]).toContain(del.status())
  })

  test('a body the JSON parser never claims is untouched (text/plain reaches the route)', async ({ request }) => {
    // `express.json` only parses `application/json`, so this body is simply not
    // parsed: the route sees an empty body and answers with its own message. It
    // must not be swept into the parse-failure branch.
    const res = await request.post('/api/admin/login', {
      headers: { 'content-type': 'text/plain' },
      data: 'this is not json',
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error, 'the route answered, not the error handler')
      .toMatch(/Heslo/i)
  })
})

test.describe('Malformed JSON body — body-parser 4xx statuses are preserved, not flattened', () => {
  test('an oversized body is 413, not 400 and not 500', async ({ request }) => {
    // `express.json({ limit: '10mb' })`. body-parser raises `entity.too.large`
    // carrying its own 413; "payload too large" is a strictly more useful answer
    // than a blanket 400, and the client can act on it.
    const oversized = `{"password":"${'a'.repeat(11 * 1024 * 1024)}"}`
    const res = await request.post('/api/admin/login', { headers: JSON_HEADERS, data: oversized })
    expect(res.status()).toBe(413)
  })

  test('an unsupported charset is 415, not 400 and not 500', async ({ request }) => {
    const res = await request.post('/api/admin/login', {
      headers: { 'content-type': 'application/json; charset=utf-32' },
      data: '{"password":"x"}',
    })
    expect(res.status()).toBe(415)
  })
})

test.describe('Malformed JSON body — a genuine server fault is still a 500', () => {
  test('the CORS rejection (no status on the error) keeps returning 500', async ({ request }) => {
    // `index.js`'s CORS callback rejects with a bare `Error` — no `status`, no
    // `type` — which is exactly the shape that must NOT be translated. This is the
    // one reachable non-body error that reaches the global handler, so it is the
    // guard against a fix that turns every error into a 400.
    const res = await request.get('/api/health', { headers: { Origin: 'https://evil.example.com' } })
    expect(res.status(), 'a non-client error keeps its 500').toBe(500)
  })
})
