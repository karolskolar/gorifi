// GA-T2 — 10 §UC-GA-002 (config + verifier + the e2e seam), plus resolved decisions
// #2 (Google is modern-mode only — not exercised here, no endpoint exists yet) and
// #4 (`GOOGLE_CLIENT_ID` is SERVED config, reaching the frontend through the public
// `GET /api/friends/auth-mode`).
//
// THIS ROW SHIPS NO ENDPOINT. `helpers/google-auth.js` is a library plus one new field
// on an existing public response, so the suite has exactly two observation surfaces:
//
//   1. `GET /api/friends/auth-mode` — asserted against a throwaway backend, because the
//      SAME assertion has to hold two ways (configured ⇒ the id, unconfigured ⇒ literal
//      `null`) and the gate server can only be one of them at a time.
//   2. The helper itself, driven in a CHILD PROCESS — the `sendViaMailer` precedent
//      (e2e/mailgun-harness.js). There is no unit runner in this repo (01 §Testing) and
//      adding one is forbidden, so a child process that imports the module, calls it and
//      prints JSON is how a library gets covered here. It also captures the module's
//      BOOT LINE for free, since that is printed at import time (the mailer convention).
//
// ⚠ NOTHING HERE TOUCHES THE NETWORK BEYOND 127.0.0.1. Every child that could reach
// Google is either (a) given a token the local shape guard rejects before any outbound
// call, or (b) pointed at a local stub via the test-mode-gated certs-URL override. The
// two tests that PROVE the outbound call happens assert it against a local recorder.
//
// ⚠ `GOOGLE_CLIENT_ID` / `GOOGLE_AUTH_TEST_MODE` are BLANKED in every child unless the
// case sets them — an operator's real client id in the ambient environment must not
// change what a test measures (the harness's `MAILGUN_*` blanking rule, applied to the
// second outbound dependency).

import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CAN_SPAWN_BACKEND, freePort, startBackend } from '../mailgun-harness.js'

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HELPER_ENTRY = path.resolve(E2E_DIR, '../backend/src/helpers/google-auth.js')
// ⚠ Gated on the BACKEND SOURCE, not on the helper file existing: "the module is missing"
// must be a RED run, not 24 silent skips (the vacuity trap the DB_PATH self-skips have).
const CAN_SPAWN_HELPER = CAN_SPAWN_BACKEND
const NEEDS_SOURCE = 'needs the backend source beside e2e/ (skipped against a deployment)'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'

// The literals from §UC-GA-002. Asserted as exact strings: a Google outage reading as
// "wrong credentials" is the failure this whole row exists to prevent, so the two
// messages must never drift into each other.
const NOT_CONFIGURED = 'Prihlásenie cez Google nie je nakonfigurované'
const UNAVAILABLE = 'Overenie Google účtu momentálne nie je dostupné, skúste to neskôr'

const TEST_CLIENT_ID = 'test-client'

// A syntactically valid JWS compact serialization that no key will ever verify. It gets
// PAST the local shape guard, which is exactly the point: it is the only way to prove
// that a well-formed token DOES reach the certs fetch (and therefore that the garbage
// cases genuinely did not).
const WELL_FORMED_BOGUS_JWT = [
  Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'nosuchkid', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', sub: '42', aud: TEST_CLIENT_ID })).toString('base64url'),
  'bm90LWEtc2lnbmF0dXJl',
].join('.')

// ---------------------------------------------------------------------------
// Driving the helper in a child process.
// ---------------------------------------------------------------------------

// Each case is `{ label, kind, value?, length?, options? }`:
//   kind 'json'      — `value` is passed through verbatim (string, number, object, null)
//   kind 'undefined' — the argument is genuinely absent (JSON cannot carry it)
//   kind 'long'      — a string of `length` 'x' characters (the 4096 boundary)
async function runVerifier(env, cases) {
  const script = [
    "const mod = await import(process.env.GOOGLE_AUTH_URL)",
    "const cases = JSON.parse(process.env.GOOGLE_AUTH_CASES)",
    "const out = []",
    "for (const c of cases) {",
    "  let token",
    "  if (c.kind === 'undefined') token = undefined",
    "  else if (c.kind === 'long') token = 'x'.repeat(c.length)",
    "  else token = c.value",
    "  const started = Date.now()",
    "  let result = null",
    "  let threw = null",
    "  try { result = await mod.verifyGoogleIdToken(token, c.options) }",
    "  catch (e) { threw = String((e && e.stack) || e) }",
    "  out.push({ label: c.label, ms: Date.now() - started, result, threw })",
    "}",
    "const config = {",
    "  clientId: mod.getGoogleClientId(),",
    "  configured: mod.isGoogleAuthConfigured(),",
    "  guard: mod.requireGoogleAuthConfigured(),",
    "  maxLength: mod.GOOGLE_ID_TOKEN_MAX_LENGTH,",
    "  timeoutMs: mod.GOOGLE_VERIFY_TIMEOUT_MS,",
    "}",
    "process.stdout.write('\\nVERIFIER_RESULT:' + JSON.stringify({ out, config }) + '\\n')",
  ].join('\n')

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      GOOGLE_AUTH_URL: pathToFileURL(HELPER_ENTRY).href,
      GOOGLE_AUTH_CASES: JSON.stringify(cases),
      // Blanked first; only `env` can turn anything on.
      GOOGLE_CLIENT_ID: '',
      GOOGLE_AUTH_TEST_MODE: '',
      GOOGLE_AUTH_TEST_CERTS_URL: '',
      GOOGLE_AUTH_TEST_TIMEOUT_MS: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', (c) => { output += c })
  child.stderr.on('data', (c) => { output += c })
  const exitCode = await new Promise((resolve) => child.on('exit', resolve))

  const match = output.match(/VERIFIER_RESULT:(.*)/)
  if (exitCode !== 0 || !match) {
    throw new Error(`google-auth child failed (exit ${exitCode})\n${output}`)
  }
  const parsed = JSON.parse(match[1])
  // The boot line is printed at import time, so it is in this same capture.
  return { ...parsed, stdout: output, bootLine: (output.match(/^\[google-auth\].*$/m) || [''])[0] }
}

// Convenience: one case, one result.
async function verifyOne(env, testCase) {
  const { out, config, bootLine, stdout } = await runVerifier(env, [testCase])
  return { ...out[0], config, bootLine, stdout }
}

// ---------------------------------------------------------------------------
// Local stand-ins for Google's JWKS endpoint.
// ---------------------------------------------------------------------------

// Accepts the connection and NEVER replies — the hang the ~10 s bound exists for.
async function startBlackHole() {
  const requests = []
  const sockets = new Set()
  const server = http.createServer((req) => { requests.push(req.url) })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  const port = await freePort()
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${port}/certs`,
    requests,
    async stop() {
      for (const s of sockets) s.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// ⚠ A PLAUSIBLE cert map, not `{}`. The helper treats a 200 that carries no usable keys
// as an OUTAGE (a captive portal / proxy error page must not read as "wrong
// credentials"), so a recorder serving `{}` would answer 503 and every "the fetch
// succeeded, the token is what's wrong" test would be measuring the wrong branch. The
// PEM text is deliberately not a real certificate — the `kid` never matches
// `WELL_FORMED_BOGUS_JWT`'s, so verification fails at "No pem found for envelope",
// which is a genuine 401.
const PLAUSIBLE_PEM_CERTS = JSON.stringify({
  'some-real-looking-kid': '-----BEGIN CERTIFICATE-----\nMIIBogus\n-----END CERTIFICATE-----\n',
})

// Replies 200 with that map: the fetch SUCCEEDS, so anything that fails afterwards is a
// verification failure, not an outage.
async function startCertRecorder({ body = PLAUSIBLE_PEM_CERTS, cacheControl = 'public, max-age=3600' } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const headers = { 'Content-Type': 'application/json' }
    if (cacheControl) headers['Cache-Control'] = cacheControl
    res.writeHead(200, headers)
    res.end(body)
  })
  const port = await freePort()
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${port}/certs`,
    requests,
    async stop() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// The same recorder on an arbitrary loopback-range address. `127.0.0.2` is routable on
// Linux but is NOT the literal the helper's loopback guard accepts — which is what makes
// "zero requests" a real assertion rather than an unreachable host.
async function startCertRecorderOn(host) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' })
    res.end(PLAUSIBLE_PEM_CERTS)
  })
  const port = await freePort()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return {
    url: `http://${host}:${port}/certs`,
    requests,
    async stop() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// First request answers fast with usable certs and NO `cache-control` (so the library
// never caches — `certificateExpiry` stays null); every later request hangs forever.
// This is the ONLY shape that makes the two awaited steps both spend real time, which is
// what the composed-budget test needs.
async function startOnceThenHang({ firstDelayMs = 800 } = {}) {
  const requests = []
  const sockets = new Set()
  const timers = new Set()
  let served = 0
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    if (served++ > 0) return // hang
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (res.writableEnded) return
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(PLAUSIBLE_PEM_CERTS)
    }, firstDelayMs)
    timers.add(timer)
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  const port = await freePort()
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${port}/certs`,
    requests,
    async stop() {
      for (const t of timers) clearTimeout(t)
      for (const s of sockets) s.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// Always answers HTTP 500 — a RETRYABLE status, so `AuthClient.RETRY_CONFIG` makes
// gaxios try again with backoff. This is the only shape that separates the two timeout
// layers (see the test that uses it).
async function startFlakyCerts() {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end('{"error":"nope"}')
  })
  const port = await freePort()
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${port}/certs`,
    requests,
    async stop() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// A port nothing listens on — ECONNREFUSED, the other half of "network failure".
async function deadPort() {
  const port = await freePort()
  // Make sure it really is free at the moment we hand it over.
  await new Promise((resolve, reject) => {
    const probe = net.connect(port, '127.0.0.1')
    probe.on('error', () => resolve())
    probe.on('connect', () => { probe.destroy(); reject(new Error('port unexpectedly in use')) })
  })
  return `http://127.0.0.1:${port}/certs`
}

// ===========================================================================
// 1. Served config — `GET /api/friends/auth-mode` (resolved decision #4)
// ===========================================================================

test.describe('§UC-GA-002 — googleClientId on the public auth-mode response', () => {
  test('the gate server publishes the field with the documented type', async ({ request }) => {
    // Whatever this deployment is configured with, the CONTRACT is: the key exists and
    // is `string | null`. `undefined` (an absent key) is the failure the frontend cannot
    // distinguish from "not configured yet" without a version check.
    const res = await request.get(`${BASE_URL}/api/friends/auth-mode`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Object.prototype.hasOwnProperty.call(body, 'googleClientId')).toBe(true)
    expect(body.googleClientId === null || typeof body.googleClientId === 'string').toBe(true)

    // ⚠ Constraint: adding a field to a PUBLIC unauthenticated response is the moment to
    // check nothing else rode along. The endpoint answers exactly these two keys.
    expect(Object.keys(body).sort()).toEqual(['authMode', 'googleClientId'])
  })

  test('unconfigured ⇒ googleClientId is literally null, and authMode is unmoved', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    const backend = await startBackend({ GOOGLE_CLIENT_ID: '', GOOGLE_AUTH_TEST_MODE: '' })
    try {
      const res = await fetch(`${backend.baseUrl}/api/friends/auth-mode`)
      expect(res.status).toBe(200)
      const raw = await res.text()
      const body = JSON.parse(raw)
      // Not `undefined`, not `''` — the frontend keys "hide every Google control" on
      // exactly this value, and `""` is falsy but would still be a string.
      expect(body.googleClientId).toBeNull()
      expect(raw).toContain('"googleClientId":null')
      expect(body.authMode).toBe('legacy')
      expect(Object.keys(body).sort()).toEqual(['authMode', 'googleClientId'])
    } finally {
      await backend.stop()
    }
  })

  test('configured ⇒ googleClientId is the env value, served without auth', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    const backend = await startBackend({ GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com' })
    try {
      const res = await fetch(`${backend.baseUrl}/api/friends/auth-mode`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.googleClientId).toBe('123.apps.googleusercontent.com')
      expect(Object.keys(body).sort()).toEqual(['authMode', 'googleClientId'])
    } finally {
      await backend.stop()
    }
  })
})

// ===========================================================================
// 2. The boot line — the ONLY production audit signal for the test seam
// ===========================================================================

test.describe('§UC-GA-002 — the boot line names the resolved mode', () => {
  test.skip(!CAN_SPAWN_HELPER, NEEDS_SOURCE)

  test('unconfigured ⇒ mode=off', async () => {
    const { bootLine } = await runVerifier({}, [])
    expect(bootLine).toContain('[google-auth]')
    expect(bootLine).toContain('mode=off')
    expect(bootLine).not.toContain('mode=TEST')
  })

  test('configured, real verification ⇒ mode=google and the client id', async () => {
    const { bootLine } = await runVerifier({ GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com' }, [])
    expect(bootLine).toContain('mode=google')
    expect(bootLine).toContain('123.apps.googleusercontent.com')
    expect(bootLine).not.toContain('mode=TEST')
  })

  test('GOOGLE_AUTH_TEST_MODE ⇒ mode=TEST, shouted', async () => {
    const { bootLine } = await runVerifier(
      { GOOGLE_CLIENT_ID: TEST_CLIENT_ID, GOOGLE_AUTH_TEST_MODE: '1' },
      [],
    )
    expect(bootLine).toContain('mode=TEST')
    // A production log grep has to be able to find this without knowing the wording.
    expect(bootLine).toContain('GOOGLE_AUTH_TEST_MODE')
    expect(bootLine.toLowerCase()).toContain('production')
  })

  test('test mode set but the feature is OFF is still reported, not silently swallowed', async () => {
    const { bootLine } = await runVerifier({ GOOGLE_AUTH_TEST_MODE: '1' }, [])
    expect(bootLine).toContain('mode=off')
    expect(bootLine).toContain('GOOGLE_AUTH_TEST_MODE')
  })

  test('a real backend prints it at boot, right beside the mailer line', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    const backend = await startBackend({ GOOGLE_CLIENT_ID: TEST_CLIENT_ID, GOOGLE_AUTH_TEST_MODE: '1' })
    try {
      // The helper must actually be imported by the server, or the audit line is a
      // property of a module nothing loads.
      expect(backend.logs()).toContain('[google-auth]')
      expect(backend.logs()).toContain('mode=TEST')
      expect(backend.logs()).toContain('[mailer]')
    } finally {
      await backend.stop()
    }
  })

  test('a real backend with no Google env reports mode=off', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    const backend = await startBackend({})
    try {
      expect(backend.logs()).toContain('mode=off')
      expect(backend.logs()).not.toContain('mode=TEST')
    } finally {
      await backend.stop()
    }
  })
})

// ===========================================================================
// 3. The feature-off contract (constraint 8)
// ===========================================================================

test.describe('§UC-GA-002 — GOOGLE_CLIENT_ID absent = the whole feature is off', () => {
  test.skip(!CAN_SPAWN_HELPER, NEEDS_SOURCE)

  test('every input answers the 503 not-configured guard, whatever its shape', async () => {
    const { out, config } = await runVerifier({}, [
      { label: 'test-token', kind: 'json', value: 'TEST:sub1:a@b.c' },
      { label: 'well-formed', kind: 'json', value: WELL_FORMED_BOGUS_JWT },
      { label: 'garbage', kind: 'json', value: 'garbage' },
      { label: 'number', kind: 'json', value: 123 },
    ])
    for (const row of out) {
      expect(row.threw, `${row.label} must not throw`).toBeNull()
      expect(row.result.status, row.label).toBe(503)
      expect(row.result.error, row.label).toBe(NOT_CONFIGURED)
      expect(row.result.reason, row.label).toBe('not_configured')
      expect(row.result.identity, row.label).toBeUndefined()
    }
    // ⚠ The config guard runs BEFORE the type guard: an unconfigured deployment must not
    // answer a complaint about the token's shape for a feature it does not have.
    expect(out[3].result.status).toBe(503)

    expect(config.clientId).toBeNull()
    expect(config.configured).toBe(false)
    expect(config.guard).toEqual({ error: NOT_CONFIGURED, status: 503, reason: 'not_configured' })
  })

  test('test mode alone cannot switch the feature on', async () => {
    // GOOGLE_AUTH_TEST_MODE without a client id is inert: the seam is not a second way
    // to enable Google sign-in.
    const row = await verifyOne({ GOOGLE_AUTH_TEST_MODE: '1' }, {
      label: 'test-token', kind: 'json', value: 'TEST:sub1:a@b.c',
    })
    expect(row.result.status).toBe(503)
    expect(row.result.reason).toBe('not_configured')
  })

  test('configured ⇒ the config guard passes and reports the id', async () => {
    const { config } = await runVerifier({ GOOGLE_CLIENT_ID: TEST_CLIENT_ID }, [])
    expect(config.clientId).toBe(TEST_CLIENT_ID)
    expect(config.configured).toBe(true)
    expect(config.guard).toBeNull()
  })
})

// ===========================================================================
// 4. The type guard (constraint 6 — 400, never a 500)
// ===========================================================================

test.describe('§UC-GA-002 — the id_token type guard', () => {
  test.skip(!CAN_SPAWN_HELPER, NEEDS_SOURCE)

  test('non-string and empty shapes ⇒ 400 field id_token, never a throw', async () => {
    const { out, config } = await runVerifier({ GOOGLE_CLIENT_ID: TEST_CLIENT_ID }, [
      { label: 'number', kind: 'json', value: 123 },
      { label: 'object', kind: 'json', value: {} },
      { label: 'array', kind: 'json', value: [] },
      { label: 'boolean', kind: 'json', value: true },
      { label: 'null', kind: 'json', value: null },
      { label: 'undefined', kind: 'undefined' },
      { label: 'empty', kind: 'json', value: '' },
      { label: 'whitespace', kind: 'json', value: '   ' },
      { label: 'too-long', kind: 'long', length: 4097 },
    ])
    for (const row of out) {
      expect(row.threw, `${row.label} must not throw`).toBeNull()
      expect(row.result.status, row.label).toBe(400)
      expect(row.result.field, row.label).toBe('id_token')
      expect(row.result.reason, row.label).toBe('bad_request')
      expect(row.result.identity, row.label).toBeUndefined()
    }
    expect(config.maxLength).toBe(4096)
  })

  test('the field name is overridable for the register attach (google_id_token)', async () => {
    // §UC-GA-008 names the body field `google_id_token`; the guard must be able to say so
    // rather than making that call site re-implement the bound.
    const row = await verifyOne({ GOOGLE_CLIENT_ID: TEST_CLIENT_ID }, {
      label: 'number', kind: 'json', value: 123, options: { field: 'google_id_token' },
    })
    expect(row.result.status).toBe(400)
    expect(row.result.field).toBe('google_id_token')
  })

  test('exactly 4096 characters is INSIDE the bound (it fails later, as a token)', async () => {
    const row = await verifyOne({ GOOGLE_CLIENT_ID: TEST_CLIENT_ID }, {
      label: 'boundary', kind: 'long', length: 4096,
    })
    expect(row.result.status).toBe(401)
    expect(row.result.reason).toBe('invalid')
  })
})

// ===========================================================================
// 5. The test seam — TEST:<sub>:<email>
// ===========================================================================

test.describe('§UC-GA-002 — the GOOGLE_AUTH_TEST_MODE seam', () => {
  test.skip(!CAN_SPAWN_HELPER, NEEDS_SOURCE)

  const TEST_ENV = { GOOGLE_CLIENT_ID: TEST_CLIENT_ID, GOOGLE_AUTH_TEST_MODE: '1' }

  test('TEST:sub1:a@b.c verifies with no network call at all', async () => {
    const recorder = await startCertRecorder()
    try {
      const row = await verifyOne(
        { ...TEST_ENV, GOOGLE_AUTH_TEST_CERTS_URL: recorder.url },
        { label: 'seam', kind: 'json', value: 'TEST:sub1:a@b.c' },
      )
      expect(row.result.identity).toEqual({ sub: 'sub1', email: 'a@b.c', emailVerified: true })
      expect(row.result.error).toBeUndefined()
      expect(recorder.requests, 'the seam must not touch the network').toHaveLength(0)
    } finally {
      await recorder.stop()
    }
  })

  test('an empty email in the seam token yields email null, sub still the key', async () => {
    const row = await verifyOne(TEST_ENV, { label: 'no-email', kind: 'json', value: 'TEST:sub9:' })
    expect(row.result.identity).toEqual({ sub: 'sub9', email: null, emailVerified: true })
  })

  test('a malformed TEST: token is rejected, not smuggled onto the real path', async () => {
    const recorder = await startCertRecorder()
    try {
      const { out } = await runVerifier(
        { ...TEST_ENV, GOOGLE_AUTH_TEST_CERTS_URL: recorder.url },
        [
          { label: 'no-parts', kind: 'json', value: 'TEST:' },
          { label: 'no-email-part', kind: 'json', value: 'TEST:sub1' },
          { label: 'empty-sub', kind: 'json', value: 'TEST::a@b.c' },
        ],
      )
      for (const row of out) {
        expect(row.result.status, row.label).toBe(401)
        expect(row.result.reason, row.label).toBe('invalid')
      }
      expect(recorder.requests).toHaveLength(0)
    } finally {
      await recorder.stop()
    }
  })

  test('WITHOUT the env var a TEST: token is just an invalid token', async () => {
    // The whole safety property: a production deployment cannot be talked into a login
    // by anyone who knows the seam's format.
    const row = await verifyOne({ GOOGLE_CLIENT_ID: TEST_CLIENT_ID }, {
      label: 'seam-off', kind: 'json', value: 'TEST:sub1:a@b.c',
    })
    expect(row.result.status).toBe(401)
    expect(row.result.reason).toBe('invalid')
    expect(row.result.identity).toBeUndefined()
    // And it is rejected LOCALLY — a `TEST:` string is not a JWS, so it never becomes
    // an outbound request either.
    expect(row.ms).toBeLessThan(2000)
  })

  test('GOOGLE_AUTH_TEST_MODE=0 / empty does not enable the seam', async () => {
    const { out } = await runVerifier({ GOOGLE_CLIENT_ID: TEST_CLIENT_ID, GOOGLE_AUTH_TEST_MODE: '0' }, [
      { label: 'zero', kind: 'json', value: 'TEST:sub1:a@b.c' },
    ])
    expect(out[0].result.status).toBe(401)
  })

  test('⚠ the env parser is an ALLOW-list: off/no/disabled/n leave the seam OFF', async () => {
    // ⚠ THE HIGHEST-STAKES ASSERTION IN THIS FILE. A deny-list parser (anything but
    // ''/'0'/'false' ⇒ on) reads every one of these as ON — and they are precisely what
    // an operator writes when they believe they are switching something OFF. Once
    // §UC-GA-003 exists that is a remote total bypass: `TEST:<any sub>:x@y` logs in as
    // whoever that sub is linked to. The boot line is an audit signal, not a gate.
    for (const value of ['off', 'OFF', 'no', 'n', 'disabled', 'none', 'nope', 'FALSE', '2', 'yes-please']) {
      const row = await verifyOne({ GOOGLE_CLIENT_ID: TEST_CLIENT_ID, GOOGLE_AUTH_TEST_MODE: value }, {
        label: value, kind: 'json', value: 'TEST:sub1:a@b.c',
      })
      expect(row.result.status, `GOOGLE_AUTH_TEST_MODE=${value} must NOT enable the seam`).toBe(401)
      expect(row.result.identity, `GOOGLE_AUTH_TEST_MODE=${value}`).toBeUndefined()
      expect(row.bootLine, `GOOGLE_AUTH_TEST_MODE=${value}`).not.toContain('mode=TEST')
    }
    // Non-vacuity: the two accepted spellings really do enable it.
    for (const value of ['1', 'true', 'TRUE']) {
      const row = await verifyOne({ GOOGLE_CLIENT_ID: TEST_CLIENT_ID, GOOGLE_AUTH_TEST_MODE: value }, {
        label: value, kind: 'json', value: 'TEST:sub1:a@b.c',
      })
      expect(row.result.identity, `GOOGLE_AUTH_TEST_MODE=${value} must enable the seam`).toEqual({
        sub: 'sub1', email: 'a@b.c', emailVerified: true,
      })
    }
  })

  test('⚠ a NON-LOOPBACK GOOGLE_AUTH_TEST_CERTS_URL is ignored', async () => {
    // Test mode on its own is a LOUD bypass (`TEST:` tokens are unmistakable). A
    // redirectable JWKS URL would make it a SILENT one — an attacker hosting a key set
    // could sign a token with our `aud` and `iss: accounts.google.com` for any `sub`.
    //
    // ⚠ THE STUB RUNS ON 127.0.0.2, NOT 127.0.0.1. That is a locally routable address on
    // Linux, so the "attacker" server is genuinely reachable — the helper simply refuses
    // to use it because the hostname is not the loopback literal. Zero requests to it is
    // therefore a real assertion, not an artefact of an unreachable host.
    //
    // ⚠ Hermetic: the timeout is 1 ms, so the fallback to Google's real endpoint is
    // abandoned before it can matter, and the assertions below hold identically with no
    // internet at all — the outcome never depends on Google being reachable.
    const evil = await startCertRecorderOn('127.0.0.2')
    try {
      const row = await verifyOne(
        {
          GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
          GOOGLE_AUTH_TEST_MODE: '1',
          GOOGLE_AUTH_TEST_CERTS_URL: evil.url,
          GOOGLE_AUTH_TEST_TIMEOUT_MS: '1',
        },
        { label: 'evil-certs', kind: 'json', value: WELL_FORMED_BOGUS_JWT },
      )
      expect(row.stdout).toContain('ignoring GOOGLE_AUTH_TEST_CERTS_URL')
      expect(row.stdout).toContain('127.0.0.2')
      expect(evil.requests, 'the attacker JWKS must never be fetched').toHaveLength(0)
      // Never an identity — the only outcome that would matter.
      expect(row.result.identity).toBeUndefined()
      expect([401, 503]).toContain(row.result.status)
    } finally {
      await evil.stop()
    }
  })
})

// ===========================================================================
// 6. Invalid vs unavailable — the 401/503 contract (constraint 2)
// ===========================================================================

test.describe('§UC-GA-002 — 401 (invalid) is never confused with 503 (outage)', () => {
  test.skip(!CAN_SPAWN_HELPER, NEEDS_SOURCE)

  test('garbage never leaves the process: 401 with zero outbound requests', async () => {
    const recorder = await startCertRecorder()
    try {
      const { out } = await runVerifier(
        {
          GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
          GOOGLE_AUTH_TEST_MODE: '1',
          GOOGLE_AUTH_TEST_CERTS_URL: recorder.url,
        },
        [
          { label: 'word', kind: 'json', value: 'garbage' },
          { label: 'two-segments', kind: 'json', value: 'aaa.bbb' },
          { label: 'four-segments', kind: 'json', value: 'aaa.bbb.ccc.ddd' },
          { label: 'dots', kind: 'json', value: '...' },
          { label: 'bad-charset', kind: 'json', value: 'aaa.bbb.c c' },
        ],
      )
      for (const row of out) {
        expect(row.threw, `${row.label} must not throw`).toBeNull()
        expect(row.result.status, row.label).toBe(401)
        expect(row.result.reason, row.label).toBe('invalid')
      }
      // ⚠ 10 §UC-GA-013 claims malformed tokens "fail locally at decode, no network".
      // In google-auth-library 11 the certs fetch happens BEFORE the token is decoded,
      // so that is only true because the helper adds its own local shape gate. This
      // assertion is what keeps it true.
      expect(recorder.requests, 'garbage must not cost an outbound request').toHaveLength(0)
    } finally {
      await recorder.stop()
    }
  })

  test('a WELL-FORMED bogus token does reach the certs fetch, and still 401s', async () => {
    // The non-vacuity counterpart of the test above: without it, "zero requests" could be
    // satisfied by a helper that never calls Google at all.
    const recorder = await startCertRecorder()
    try {
      const row = await verifyOne(
        {
          GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
          GOOGLE_AUTH_TEST_MODE: '1',
          GOOGLE_AUTH_TEST_CERTS_URL: recorder.url,
        },
        { label: 'bogus-jwt', kind: 'json', value: WELL_FORMED_BOGUS_JWT },
      )
      expect(recorder.requests.length).toBeGreaterThan(0)
      expect(row.result.status).toBe(401)
      expect(row.result.reason).toBe('invalid')
    } finally {
      await recorder.stop()
    }
  })

  test('a hanging JWKS endpoint ⇒ 503 outage, bounded by the timeout', async () => {
    const blackHole = await startBlackHole()
    try {
      const row = await verifyOne(
        {
          GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
          GOOGLE_AUTH_TEST_MODE: '1',
          GOOGLE_AUTH_TEST_CERTS_URL: blackHole.url,
          GOOGLE_AUTH_TEST_TIMEOUT_MS: '400',
        },
        { label: 'hang', kind: 'json', value: WELL_FORMED_BOGUS_JWT },
      )
      expect(row.threw).toBeNull()
      expect(row.result.status).toBe(503)
      expect(row.result.error).toBe(UNAVAILABLE)
      expect(row.result.reason).toBe('unavailable')
      // The bound is the point: the server hung forever and the call still returned.
      expect(blackHole.requests.length).toBeGreaterThan(0)
      expect(row.ms).toBeGreaterThanOrEqual(350)
      expect(row.ms).toBeLessThan(5000)
    } finally {
      await blackHole.stop()
    }
  })

  test('a refused connection ⇒ 503 outage, not a 401', async () => {
    // The failure this contract exists for: Google unreachable must never read to the
    // friend as "your Google account is wrong".
    const url = await deadPort()
    const row = await verifyOne(
      {
        GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
        GOOGLE_AUTH_TEST_MODE: '1',
        GOOGLE_AUTH_TEST_CERTS_URL: url,
        GOOGLE_AUTH_TEST_TIMEOUT_MS: '2000',
      },
      { label: 'refused', kind: 'json', value: WELL_FORMED_BOGUS_JWT },
    )
    expect(row.threw).toBeNull()
    expect(row.result.status).toBe(503)
    expect(row.result.error).toBe(UNAVAILABLE)
    expect(row.result.reason).toBe('unavailable')
  })

  test('a RETRYING JWKS endpoint is bounded by the outer deadline, not by the retries', async () => {
    // ⚠ THE TEST THAT SEPARATES THE TWO TIMEOUT LAYERS, and the reason both exist.
    // A hanging endpoint is bounded by EITHER layer alone (verified by mutation), so it
    // proves nothing about the outer deadline. A retryable HTTP 500 does: gaxios re-arms
    // its per-request timeout for every retry, so with only the transport timeout this
    // same call measured 2137 ms over 4 attempts against a 400 ms configured bound —
    // 5.3× over, i.e. ~53 s at the shipped 10 s, with an Express handler held open the
    // whole time. With the outer deadline it is ~400 ms.
    const flaky = await startFlakyCerts()
    try {
      const row = await verifyOne(
        {
          GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
          GOOGLE_AUTH_TEST_MODE: '1',
          GOOGLE_AUTH_TEST_CERTS_URL: flaky.url,
          GOOGLE_AUTH_TEST_TIMEOUT_MS: '400',
        },
        { label: 'flaky', kind: 'json', value: WELL_FORMED_BOGUS_JWT },
      )
      expect(row.result.status).toBe(503)
      expect(row.result.reason).toBe('unavailable')
      expect(flaky.requests.length).toBeGreaterThan(0)
      expect(row.ms, 'the deadline must cut the retry chain').toBeLessThan(1500)
    } finally {
      await flaky.stop()
    }
  })

  test('⚠ a 200 carrying NO USABLE KEYS is an outage, not an invalid token', async () => {
    // A captive portal or a proxy error page that happens to be JSON: the fetch
    // SUCCEEDS, so nothing looks like a transport fault, and verification then throws an
    // ordinary "No pem found for envelope" — which would classify as 401. That is the
    // "an outage must not read as wrong credentials" failure this contract exists to
    // prevent, in the one path where it would otherwise survive.
    const cases = [
      { label: 'empty map', body: '{}' },
      { label: 'proxy error json', body: '{"error":"upstream unavailable"}' },
      { label: 'json null', body: 'null' },
      { label: 'json array', body: '[]' },
    ]
    for (const c of cases) {
      const portal = await startCertRecorder({ body: c.body })
      try {
        const row = await verifyOne(
          {
            GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
            GOOGLE_AUTH_TEST_MODE: '1',
            GOOGLE_AUTH_TEST_CERTS_URL: portal.url,
            GOOGLE_AUTH_TEST_TIMEOUT_MS: '2000',
          },
          { label: c.label, kind: 'json', value: WELL_FORMED_BOGUS_JWT },
        )
        expect(portal.requests.length, c.label).toBeGreaterThan(0)
        expect(row.result.status, c.label).toBe(503)
        expect(row.result.error, c.label).toBe(UNAVAILABLE)
        expect(row.result.reason, c.label).toBe('unavailable')
      } finally {
        await portal.stop()
      }
    }
  })

  test('⚠ the ~10 s is ONE budget for the whole call, not one per awaited step', async () => {
    // The helper awaits twice: the explicit certs fetch, then `verifyIdToken`. Giving
    // each its own `timeout` makes the composed worst case 2 × timeout — 20 s at the
    // shipped value, where §UC-GA-002 says ~10 s.
    //
    // Reproducing it needs a JWKS that answers the FIRST request slowly (but under the
    // bound) with NO `cache-control` — the library only caches when that header carries a
    // max-age, so `verifyIdToken` then fetches AGAIN — and hangs on that second request.
    // With one shared budget: ~1000 ms. With two independent ones: 800 + 1000 = ~1800 ms.
    const server = await startOnceThenHang({ firstDelayMs: 800 })
    try {
      const row = await verifyOne(
        {
          GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
          GOOGLE_AUTH_TEST_MODE: '1',
          GOOGLE_AUTH_TEST_CERTS_URL: server.url,
          GOOGLE_AUTH_TEST_TIMEOUT_MS: '1000',
        },
        { label: 'two-step', kind: 'json', value: WELL_FORMED_BOGUS_JWT },
      )
      // Both awaited steps really did go to the network — otherwise this proves nothing.
      expect(server.requests.length, 'the verify step must have re-fetched').toBeGreaterThan(1)
      expect(row.result.status).toBe(503)
      expect(row.result.reason).toBe('unavailable')
      expect(row.ms, 'the composed call must respect ONE budget').toBeLessThan(1500)
    } finally {
      await server.stop()
    }
  })

  test('the shipped default timeout is ~10 s', async () => {
    const { config } = await runVerifier({ GOOGLE_CLIENT_ID: TEST_CLIENT_ID }, [])
    expect(config.timeoutMs).toBe(10_000)
  })

  test('the two 503s are distinguishable: not_configured vs unavailable', async () => {
    // Both are 503, and a call site that cannot tell them apart would report an outage
    // for a deployment that simply has the feature switched off.
    const off = await verifyOne({}, { label: 'off', kind: 'json', value: WELL_FORMED_BOGUS_JWT })
    const url = await deadPort()
    const down = await verifyOne(
      {
        GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
        GOOGLE_AUTH_TEST_MODE: '1',
        GOOGLE_AUTH_TEST_CERTS_URL: url,
        GOOGLE_AUTH_TEST_TIMEOUT_MS: '2000',
      },
      { label: 'down', kind: 'json', value: WELL_FORMED_BOGUS_JWT },
    )
    expect(off.result.reason).toBe('not_configured')
    expect(down.result.reason).toBe('unavailable')
    expect(off.result.error).not.toBe(down.result.error)
  })
})

// ===========================================================================
// 7. It never throws into a request handler (constraint 3 / the mailer rule)
// ===========================================================================

test('§UC-GA-002 — every documented input shape returns a result, none throws', async () => {
  test.skip(!CAN_SPAWN_HELPER, NEEDS_SOURCE)
  const url = await deadPort()
  const { out } = await runVerifier(
    {
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      GOOGLE_AUTH_TEST_MODE: '1',
      GOOGLE_AUTH_TEST_CERTS_URL: url,
      GOOGLE_AUTH_TEST_TIMEOUT_MS: '1500',
    },
    [
      { label: 'seam', kind: 'json', value: 'TEST:s:e@x.y' },
      { label: 'number', kind: 'json', value: 123 },
      { label: 'object', kind: 'json', value: { a: 1 } },
      { label: 'nested', kind: 'json', value: { toString: 1 } },
      { label: 'array', kind: 'json', value: ['a', 'b'] },
      { label: 'null', kind: 'json', value: null },
      { label: 'undefined', kind: 'undefined' },
      { label: 'garbage', kind: 'json', value: 'garbage' },
      { label: 'bogus-jwt', kind: 'json', value: WELL_FORMED_BOGUS_JWT },
      { label: 'unicode', kind: 'json', value: 'ľščťž.ňäô.ýá' },
    ],
  )
  expect(out).toHaveLength(10)
  for (const row of out) {
    expect(row.threw, `${row.label} threw`).toBeNull()
    expect(row.result, `${row.label} returned nothing`).toBeTruthy()
    const ok = row.result.identity !== undefined
    expect(ok || [400, 401, 503].includes(row.result.status), `${row.label} status`).toBe(true)
  }
})
