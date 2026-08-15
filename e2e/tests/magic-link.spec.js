// ML-T2 — 09 §UC-ML-003 (the enumeration-safe request endpoint), §UC-ML-004 (the
// magic-link mail) and §UC-ML-009 rule 1 (a new request invalidates its predecessors).
// ML-T3 — 09 §UC-ML-005 (redemption: the atomic single-use write, the ONE neutral 401,
// the login-shaped 200, and the `/magic/:token` page) appended at the bottom.
//
// ⚠ ML-T3 EXTENDED THIS FILE RATHER THAN ADDING ITS OWN, deliberately: §UC-ML-010
// obligation 1 names this exact filename for the FULL-FLOW spec, ML-T2's header above
// reserved it for exactly this append, and — the load-bearing reason — the raw token's
// ONLY observable source is the stub-captured mail body, so every redemption test has
// to sit inside the same `withMailHarness` + `makeApi` scaffolding the request tests
// already build. A second file would have had to fork both. ML-T7 appends the
// invalidation matrix here for the same reason.
//
// TWO EXECUTION MODES, and the split is forced by the environment:
//
//  • The SHARED server runs `auth_mode = 'legacy'` (e2e/seed.mjs) and
//    `modern-login.spec.js` documents why nothing may ever write that setting on it —
//    a spec that flips it to `modern` and dies leaves the rest of the suite broken.
//    So the shared server carries only what is mode-independent: the input-shape 400s,
//    anonymous access, and the LEGACY-MODE gate itself (which is a first-class
//    acceptance case: a perfect match must still produce the neutral 200 and write
//    nothing).
//  • Everything that needs `modern` — every match path, the mail, the cooldown, the
//    predecessor invalidation, the GC — runs against a THROWAWAY backend with a stub
//    Mailgun (`withMailHarness`, the shared EM-T2 extraction; do not fork it). That is
//    also the ONLY place the raw token is observable at all: it never appears in a
//    response, never in a log, and `login_tokens` has no read endpoint, so the stub's
//    captured multipart body is the sole surface (§UC-ML-010's "stub token-capture
//    trick").
//
// Fixtures are built per test, never in a shared `beforeAll` (the GSO-T8
// worker-restart lesson).

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
// FRIEND_NAME / FRIENDS_PASSWORD are ML-T4's: the §UC-ML-007 block at the bottom
// drives the LEGACY shared-password card, which is the seed's real login screen.
import { ADMIN_PASSWORD, FRIEND_NAME, FRIENDS_PASSWORD } from '../fixtures.js'
import {
  CAN_SPAWN_BACKEND,
  FAKE_MAILGUN_KEY,
  STUB_MAILGUN_DOMAIN,
  withMailHarness,
  multipartFields,
} from '../mailgun-harness.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const DB_PATH = process.env.DB_PATH || ''
const NEEDS_SOURCE = 'needs the backend source beside e2e/ (skipped against a deployment)'

// ⚠ THE literal. Every listed path — match, no match, no e-mail, no password, inactive,
// ambiguous e-mail, cooldown, legacy mode, and EVERY mailer outcome — answers with this
// exact byte string. Asserted as raw text, not as a parsed object, so a reordered or
// extended body reddens too.
const NEUTRAL_BODY = '{"success":true}'

// ⚠ ML-T3 / §UC-ML-005 — THE one failure literal. Unknown, expired, already used,
// inactive, ineligible, legacy-mode, malformed and over-length all answer with this
// exact status and these exact bytes. Asserted as raw text (and as an exact key set)
// so an added `reason` field, a reordered body or a different status reddens.
// ⚠ Copy status: PROPOSED, NOT SIGNED (the consolidated §UC-ML-006 OPEN).
const NEUTRAL_401_BODY =
  '{"error":"Odkaz na prihlásenie už nie je platný. Požiadajte o nový na prihlasovacej obrazovke."}'

// `fullFriend` sets its password through the admin reset route, which raises
// `must_change_password`; `cleanFriend` then changes it once to clear the flag.
const INITIAL_PASSWORD = 'initPass123'
const CHOSEN_PASSWORD = 'friendChosen9'

const DAY_MS = 24 * 60 * 60 * 1000

const MAGIC_SUBJECT = 'Prihlásenie do Podpultovky'
// The mail carries the raw 64-hex token in three places (the text part, the button
// href, the plain-URL line under the button); all three must be the same token, which
// is itself an assertion below.
const TOKEN_IN_URL = /\/magic\/([a-f0-9]{64})/g

const MAIL_ENV = { MAILGUN_API_KEY: FAKE_MAILGUN_KEY, MAILGUN_DOMAIN: STUB_MAILGUN_DOMAIN }

// The A/B pair for the mail-body test: an origin the deployment IS served from (so
// `resolveLoginUrl`'s Origin branch would honour it) and a DIFFERENT pinned base URL
// that must beat it.
const ALLOWED_ORIGIN = 'https://allowed-ml2.test'
const PINNED_BASE_URL = 'https://pinned-ml2.test'

function uniqTag() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`
}

// ── fixture builders, parameterised on a request context + admin token ────────
function makeApi(ctx, adminToken) {
  const admin = () => ({ 'X-Admin-Token': adminToken })

  return {
    async createFriend({ name, email }) {
      const r = await ctx.post('/api/friends', { headers: admin(), data: { name, email } })
      expect(r.status(), `create friend ${name}`).toBeLessThan(300)
      return await r.json()
    },
    async setUsername(id, username) {
      const r = await ctx.put(`/api/friends/${id}/admin-username`, { headers: admin(), data: { username } })
      expect(r.status(), 'set username').toBe(200)
    },
    async setPassword(id, password) {
      const r = await ctx.put(`/api/friends/${id}/reset-password`, { headers: admin(), data: { password } })
      expect(r.status(), 'reset password').toBe(200)
    },
    async deactivate(id) {
      const r = await ctx.patch(`/api/friends/${id}`, { headers: admin(), data: { active: 0 } })
      expect(r.status(), 'deactivate').toBe(200)
    },
    async setModernMode() {
      const r = await ctx.put('/api/admin/settings', { headers: admin(), data: { authMode: 'modern' } })
      expect(r.status(), 'switch to modern auth mode').toBe(200)
      expect((await r.json()).authMode).toBe('modern')
    },
    // A friend who can actually receive a link: active, username, password, e-mail.
    async fullFriend(tag, uniq, emailOverride) {
      const email = emailOverride || `ml2.${tag}.${uniq}@example.test`
      const friend = await this.createFriend({ name: `ML2 ${tag} ${uniq}`, email })
      const username = `e2e_ml2_${tag}_${uniq}`.toLowerCase().slice(0, 30)
      await this.setUsername(friend.id, username)
      await this.setPassword(friend.id, 'initPass123')
      return { ...friend, username, email }
    },
    request(identifier, opts = {}) {
      return ctx.post('/api/magic-link/request', { data: { identifier }, ...opts })
    },

    // ── ML-T3 ────────────────────────────────────────────────────────────────
    redeem(token, opts = {}) {
      return ctx.post('/api/magic-link/redeem', { data: { token }, ...opts })
    },
    async setLegacyMode() {
      const r = await ctx.put('/api/admin/settings', { headers: admin(), data: { authMode: 'legacy' } })
      expect(r.status(), 'switch back to legacy auth mode').toBe(200)
    },
    async passwordLogin(username, password) {
      const r = await ctx.post('/api/friends/auth', { data: { username, password } })
      expect(r.status(), `password login for ${username}`).toBe(200)
      return await r.json()
    },
    // `fullFriend` sets the password through the ADMIN reset route, which always
    // raises `must_change_password` (modern-login.spec.js documents this). A friend
    // who is NOT in the forced-change state therefore has to go through one real
    // password change first — which is also what a real friend does.
    async cleanFriend(tag, uniq, emailOverride) {
      const friend = await this.fullFriend(tag, uniq, emailOverride)
      const { token } = await this.passwordLogin(friend.username, INITIAL_PASSWORD)
      const changed = await ctx.put(`/api/friends/${friend.id}/change-password`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { newPassword: CHOSEN_PASSWORD },
      })
      expect(changed.status(), 'clear must_change_password').toBe(200)
      return { ...friend, password: CHOSEN_PASSWORD }
    },
  }
}

// Fire-and-forget means the send settles AFTER the response, so a captured request is
// necessarily an eventual condition. Polls rather than sleeping a fixed amount.
async function waitForStubCalls(stub, count, label) {
  await expect
    .poll(() => stub.requests.length, { message: label, timeout: 10_000 })
    .toBe(count)
}

// ⚠ Nothing may fire AFTER the expected count either. Gives the background send a beat
// to prove it stayed quiet — the "no mail on this path" half of every eligibility rule.
async function expectNoFurtherCalls(stub, count) {
  await new Promise((r) => setTimeout(r, 1200))
  expect(stub.requests.length, 'no extra outbound sends settled late').toBe(count)
}

function tokensIn(text) {
  return [...text.matchAll(TOKEN_IN_URL)].map((m) => m[1])
}

function outstandingRows(dbPath, friendId) {
  const db = new DatabaseSync(dbPath)
  try {
    return db
      .prepare('SELECT id, token_hash, expires_at, used_at, created_at FROM login_tokens WHERE friend_id = ? ORDER BY id')
      .all(friendId)
  } finally {
    db.close()
  }
}

// ── ML-T3 helpers ────────────────────────────────────────────────────────────

/** The raw token out of the NEWEST captured mail. */
function latestToken(stub) {
  expect(stub.requests.length, 'a captured mail to read the token from').toBeGreaterThan(0)
  const tokens = tokensIn(multipartFields(stub.requests[stub.requests.length - 1]).text)
  expect(tokens.length, 'the mail carries a 64-hex token').toBeGreaterThan(0)
  return tokens[0]
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function withDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** Request a link for `friend` and hand back the raw token the mail carried. */
async function captureToken(api, stub, identifier) {
  const before = stub.requests.length
  const res = await api.request(identifier)
  expect(await res.text(), 'the request half is unchanged by ML-T3').toBe(NEUTRAL_BODY)
  await waitForStubCalls(stub, before + 1, `a link was mailed for ${identifier}`)
  return latestToken(stub)
}

/**
 * The per-response half of the neutral-failure assertion: ONE status, and a body
 * carrying exactly one key. Returns the raw body.
 *
 * ⚠ IT DELIBERATELY DOES NOT COMPARE THE BODY TO `NEUTRAL_401_BODY`, and that is the
 * whole point of splitting it this way. With the literal check in here, every caller's
 * body was that literal BY CONSTRUCTION, so the `new Set(bodies).size === 1` assertions
 * below could not fail independently — they were a restatement, not a cross-class
 * check, and the comment claiming otherwise would have licensed someone to weaken this
 * helper later (review finding, ML-T3). Kept OUT here, each collecting test asserts
 * "there is exactly ONE distinct answer across all the classes I just exercised" AND
 * "that answer is the specified sentence" — two genuinely different failures, both
 * reachable: a class that answers with a different 401 body reddens the first, and a
 * uniform change of the sentence reddens the second.
 */
async function expectNeutral401(res, label) {
  const body = await res.text()
  expect(res.status(), `${label}: one status`).toBe(401)
  // No `reason`, no code, no field — any extra key is an oracle over token state.
  expect(Object.keys(JSON.parse(body)).sort(), `${label}: exactly one key`).toEqual(['error'])
  return body
}

/** The cross-class half: one distinct answer, and it is the specified sentence. */
function expectOneNeutralShape(bodies, label) {
  expect(new Set(bodies).size, `${label}: one failure shape across every class`).toBe(1)
  expect(bodies[0], `${label}: and it is the specified sentence, byte for byte`).toBe(NEUTRAL_401_BODY)
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared server — input shape, anonymity, and the legacy-mode gate
// ═════════════════════════════════════════════════════════════════════════════
test.describe('UC-ML-003 — input validation, anonymity, legacy gate (shared server)', () => {
  let ctx
  let api
  let uniq

  test.beforeEach(async () => {
    ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
    uniq = uniqTag()
    const adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
    api = makeApi(ctx, adminToken)
  })

  test.afterEach(async () => {
    await ctx.dispose()
  })

  // ⚠ The type/bounds guard has to run BEFORE anything that can throw: ML-T1's handover
  // records that `hashLoginToken` throws a TypeError on a non-string, so a malformed
  // body must be refused by shape, never reach the hash, and never surface as a 500.
  for (const value of [5, null, true, {}, [], ['a'], { toString: null }]) {
    test(`a non-string identifier (${JSON.stringify(value)}) is a 400 with a field marker, never a 500`, async () => {
      const res = await api.request(value)
      expect(res.status(), 'input-shape 400').toBe(400)
      const body = await res.json()
      expect(body.field, 'the guest.js 400-with-field contract').toBe('identifier')
      expect(typeof body.error, 'a Slovak message, not a stack').toBe('string')
      expect(body.error.length).toBeGreaterThan(0)
      expect(await res.text(), 'no stack trace leaked').not.toContain('    at ')
    })
  }

  test('an absent identifier is a 400', async () => {
    const res = await ctx.post('/api/magic-link/request', { data: {} })
    expect(res.status()).toBe(400)
    expect((await res.json()).field).toBe('identifier')
  })

  test('an empty / whitespace-only identifier is a 400 (checked after trim)', async () => {
    for (const value of ['', '   ', '\t\n ']) {
      const res = await api.request(value)
      expect(res.status(), `empty identifier ${JSON.stringify(value)}`).toBe(400)
      expect((await res.json()).field).toBe('identifier')
    }
  })

  test('a 200-character identifier is a 400, while 160 characters is accepted', async () => {
    const over = await api.request('x'.repeat(200))
    expect(over.status(), '200 chars is over the 160 bound').toBe(400)
    expect((await over.json()).field).toBe('identifier')

    // Non-vacuity: the bound is 160, not "anything long". 161 rejects, 160 passes
    // through to the neutral 200 (it matches nothing, which is exactly the point).
    const justOver = await api.request('y'.repeat(161))
    expect(justOver.status(), '161 chars rejected').toBe(400)

    const atBound = await api.request('z'.repeat(160))
    expect(atBound.status(), '160 chars is within bounds').toBe(200)
    expect(await atBound.text()).toBe(NEUTRAL_BODY)
  })

  test('the endpoint is public — an anonymous caller reaches it and gets the neutral 200', async () => {
    // No admin token, no friend Bearer, no X-Friends-Password: this is the recovery
    // path for someone who cannot log in.
    const anon = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      const res = await anon.post('/api/magic-link/request', { data: { identifier: `nobody-${uniq}` } })
      expect(res.status(), 'public route').toBe(200)
      expect(await res.text(), 'the one neutral literal').toBe(NEUTRAL_BODY)
      expect(res.headers()['content-type'] || '').toContain('application/json')
    } finally {
      await anon.dispose()
    }
  })

  test('LEGACY MODE: a perfect match still yields the neutral 200 and writes nothing', async () => {
    // ⚠ This is why the shared server is useful rather than merely available: it IS
    // the legacy-mode fixture (seed.mjs pins auth_mode = 'legacy'), and this file must
    // never write that setting.
    const friend = await api.fullFriend('legacy', uniq)

    const byUsername = await api.request(friend.username)
    expect(byUsername.status()).toBe(200)
    expect(await byUsername.text(), 'legacy mode is byte-identical to every other path').toBe(NEUTRAL_BODY)

    const byEmail = await api.request(friend.email)
    expect(await byEmail.text()).toBe(NEUTRAL_BODY)

    test.skip(!DB_PATH, 'requires DB_PATH to prove no token row was written')
    expect(
      outstandingRows(DB_PATH, friend.id).length,
      'the legacy gate does NO work — no login_tokens row exists for a matching friend'
    ).toBe(0)
  })

  test('no response on this endpoint ever carries a 64-hex token', async () => {
    const friend = await api.fullFriend('noleak', uniq)
    for (const identifier of [friend.username, friend.email, `unknown-${uniq}`]) {
      const body = await (await api.request(identifier)).text()
      expect(body, 'the raw token is never in an API response (UC-ML-001)').not.toMatch(/[a-f0-9]{64}/)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Throwaway backend in MODERN mode + stub Mailgun
// ═════════════════════════════════════════════════════════════════════════════
test.describe('UC-ML-003/004 — modern mode, on a throwaway backend with a stub Mailgun', () => {
  test('the 200 is byte-identical across every eligibility path, and only the two real matches mail', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withMailHarness(MAIL_ENV, async ({ stub, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()

      // (1) matches by username, (2) matches by unique e-mail
      const byUsername = await api.fullFriend('user', uniq)
      const byEmail = await api.fullFriend('mail', uniq)

      // (3) matched friend with NO e-mail — eligibility failure, no mail
      const noEmail = await api.createFriend({ name: `ML2 noemail ${uniq}` })
      const noEmailUsername = `e2e_ml2_noemail_${uniq}`.toLowerCase().slice(0, 30)
      await api.setUsername(noEmail.id, noEmailUsername)
      await api.setPassword(noEmail.id, 'initPass123')

      // (4) matched friend with NO password_hash — recovery presupposes a password to
      //     recover; a credential-less friend must not gain a login side-door here.
      const noPassEmail = `ml2.nopass.${uniq}@example.test`
      await api.createFriend({ name: `ML2 nopass ${uniq}`, email: noPassEmail })

      // (5) inactive friend
      const inactive = await api.fullFriend('inactive', uniq)
      await api.deactivate(inactive.id)

      // (6) ambiguous e-mail — two ACTIVE friends share it, so neither may be mailed
      //     ("whoever clicks first" would log in as an arbitrary friend)
      const sharedEmail = `ml2.shared.${uniq}@example.test`
      await api.createFriend({ name: `ML2 sharedA ${uniq}`, email: sharedEmail })
      const sharedB = await api.createFriend({ name: `ML2 sharedB ${uniq}`, email: sharedEmail })
      await api.setUsername(sharedB.id, `e2e_ml2_sharedb_${uniq}`.toLowerCase().slice(0, 30))
      await api.setPassword(sharedB.id, 'initPass123')

      const cases = [
        ['matching username', byUsername.username],
        ['matching unique e-mail', byEmail.email],
        ['unknown identifier', `nobody-${uniq}`],
        ['unknown identifier shaped like an e-mail', `nobody-${uniq}@example.test`],
        ['matched friend without an e-mail', noEmailUsername],
        ['matched friend without a password_hash', noPassEmail],
        ['inactive friend, by username', inactive.username],
        ['inactive friend, by e-mail', inactive.email],
        ['ambiguous e-mail (two active friends)', sharedEmail],
        ['the same identifier in a different case', byUsername.username.toUpperCase()],
      ]

      const seen = []
      for (const [label, identifier] of cases) {
        const res = await api.request(identifier)
        seen.push({ label, status: res.status(), body: await res.text() })
      }

      for (const entry of seen) {
        expect(entry.status, `${entry.label}: status`).toBe(200)
        expect(entry.body, `${entry.label}: body byte-identical to the one literal`).toBe(NEUTRAL_BODY)
      }
      // The JSON-stringify equality the acceptance criteria name, spelled out.
      const shapes = new Set(seen.map((e) => JSON.stringify(JSON.parse(e.body))))
      expect(shapes.size, 'exactly one response shape across every path').toBe(1)

      // ⚠ THE NON-VACUITY HALF. Byte-identical 200s would also be satisfied by an
      // endpoint that never mails anyone. Exactly two of the ten cases are eligible —
      // and the case-insensitive one is the SAME friend inside the 60 s cooldown, so
      // it must not add a third.
      await waitForStubCalls(stub, 2, 'exactly two outbound sends (the two eligible matches)')
      await expectNoFurtherCalls(stub, 2)

      const recipients = stub.requests.map((r) => multipartFields(r).to).sort()
      expect(recipients, 'only the two eligible friends were mailed').toEqual([byEmail.email, byUsername.email].sort())
    })
  })

  // ⚠ ML-T2 review, minor 3. The e-mail identifier is normalised with JS
  // `toLowerCase()`; the ORIGINAL implementation compared it against SQLite's `lower()`,
  // which is ASCII-ONLY — `lower('ŽOFIA@…')` is `'Žofia@…'`, so a stored address with an
  // uppercase diacritic could NEVER match. It failed closed (neutral 200, no mail), and
  // the enumeration guarantee meant nothing could ever tell the friend: they would keep
  // requesting links that were never sent. That is a recovery dead-end for exactly the
  // Slovak-alphabet users this app is for, which is why the comparison moved into JS.
  test('⚠ an uppercase-DIACRITIC e-mail address still resolves (SQLite lower() is ASCII-only)', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withMailHarness(MAIL_ENV, async ({ stub, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()

      // Every uppercase letter here is OUTSIDE ASCII except the domain part, so
      // SQLite's `lower()` leaves Ž/Ô/Č untouched while JS lowercases them.
      const stored = `ŽOFIA.ČERNÁ.${uniq}@Example.TEST`
      const friend = await api.fullFriend('diacritic', uniq, stored)

      // Non-vacuity: the fixture must genuinely contain uppercase NON-ASCII, or this
      // test would pass against the old ASCII-only SQL too.
      expect(stored, 'the fixture carries uppercase letters outside ASCII').toMatch(/[ŽČÁ]/)

      // The friend types their address the way a phone keyboard produces it.
      const typed = stored.toLowerCase()

      const res = await api.request(typed)
      expect(res.status()).toBe(200)
      expect(await res.text(), 'still the one neutral literal').toBe(NEUTRAL_BODY)

      // ⚠ The whole point: a mail is ACTUALLY sent. Against the old SQL this stayed at
      // zero and the 200 above looked identical, which is what made the dead-end silent.
      await waitForStubCalls(stub, 1, 'the diacritic address resolved and was mailed')
      expect(multipartFields(stub.requests[0]).to, 'mailed to the address as stored').toBe(stored)
    })
  })

  test('a Mailgun 500 still yields the identical 200 — the mail outcome is never an oracle', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withMailHarness(MAIL_ENV, async ({ stub, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()
      const friend = await api.fullFriend('stub500', uniq)

      stub.setReply({ status: 500, body: { message: 'Internal server error' } })

      const res = await api.request(friend.username)
      expect(res.status(), 'a failing mailer does not change the status').toBe(200)
      expect(await res.text(), 'a failing mailer does not change the body').toBe(NEUTRAL_BODY)

      // The send was genuinely attempted and genuinely failed — otherwise this proves
      // nothing about the mapping.
      await waitForStubCalls(stub, 1, 'the send was attempted against the 500 stub')

      // ⚠ And the failure did not become an unhandled rejection that takes the process
      // down: the very next request still works.
      const again = await api.request(`nobody-${uniq}`)
      expect(again.status(), 'the server survived the failed send').toBe(200)
      expect(await again.text()).toBe(NEUTRAL_BODY)
    })
  })

  // ⚠ THE FIRE-AND-FORGET PIN (§UC-ML-003 rule 2), and nothing else in this file can
  // stand in for it. The stub-500 case pins that a failed send maps to the same 200 —
  // but an AWAITED `sendMail` would produce that identical 200 too, because the mailer
  // never throws. What separates the two is only WHEN the response goes out, and
  // §UC-ML-010 item 3 forbids the obvious test (comparing matched vs unmatched response
  // times is flaky by construction). So the oracle is manufactured instead of measured:
  // a Mailgun that takes 4 s to answer. Awaiting it would hold the HTTP response for
  // those 4 s — a matched identifier would then be visibly slower than an unmatched one,
  // which IS the enumeration oracle by another route. Robust, not timing-flaky: the gap
  // being asserted is 4 s of deliberate delay against a sub-second local round trip.
  test('⚠ the response does NOT wait for the send — a 4-second Mailgun cannot slow a matched request', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    const SLOW_MS = 4000
    await withMailHarness(MAIL_ENV, async ({ stub, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()
      const friend = await api.fullFriend('slow', uniq)

      // A baseline on the SAME server: an identifier that matches nothing does no work
      // and never sends, so it is unaffected by the stub's delay either way.
      const unmatchedStart = Date.now()
      expect(await (await api.request(`nobody-${uniq}`)).text()).toBe(NEUTRAL_BODY)
      const unmatchedMs = Date.now() - unmatchedStart

      stub.setReplyDelay(SLOW_MS)

      const matchedStart = Date.now()
      const res = await api.request(friend.username)
      const matchedMs = Date.now() - matchedStart

      expect(res.status()).toBe(200)
      expect(await res.text()).toBe(NEUTRAL_BODY)
      expect(
        matchedMs,
        `a matched request answered in ${matchedMs}ms — it must not wait on the ${SLOW_MS}ms send`
      ).toBeLessThan(SLOW_MS / 2)

      // ⚠ NON-VACUITY. Without this the test would pass against a server that never
      // sends at all: the slow stub must actually have been reached, i.e. the send is
      // genuinely in flight while the response is already out.
      await waitForStubCalls(stub, 1, 'the send WAS attempted, just not awaited')

      // And the matched path is not measurably slower than the unmatched one, which is
      // the property the whole rule exists to protect.
      expect(
        Math.abs(matchedMs - unmatchedMs),
        `matched ${matchedMs}ms vs unmatched ${unmatchedMs}ms — no timing oracle`
      ).toBeLessThan(SLOW_MS / 2)

      // Let the delayed reply land before teardown so the background `.then` runs
      // against a live stub rather than a closed socket.
      stub.setReplyDelay(0)
      await new Promise((r) => setTimeout(r, SLOW_MS))
    })
  })

  test('the magic-link mail: subject, both parts, the PUBLIC_BASE_URL origin, and sha256(raw) === token_hash', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    // ⚠ The A/B of 08 §UC-EM-004, applied to THIS module's URL: the request carries a
    // DIFFERENT but genuinely ALLOWLISTED Origin (so it WOULD be honoured by
    // `resolveLoginUrl`'s second branch), and the pin must still win. Without an
    // allowlisted Origin the negative would be vacuous — `index.js`'s CORS callback
    // rejects a foreign Origin with a 500 before any route runs, so the resolver would
    // never be reached. This is what stops an attacker-chosen Origin minting the domain
    // of a link we mail to a third party.
    await withMailHarness(
      { ...MAIL_ENV, PUBLIC_BASE_URL: PINNED_BASE_URL, CORS_ORIGIN: ALLOWED_ORIGIN },
      async ({ stub, backend, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()
      const friend = await api.fullFriend('mailbody', uniq)

      const res = await api.request(friend.username, { headers: { Origin: ALLOWED_ORIGIN } })
      expect(res.status()).toBe(200)

      await waitForStubCalls(stub, 1, 'one outbound send')
      const call = stub.requests[0]
      const fields = multipartFields(call)

      expect(fields.subject, 'the subject constant').toBe(MAGIC_SUBJECT)
      expect(fields.to).toBe(friend.email)
      expect(fields['o:tracking-clicks'], 'tracking stays disabled per message').toBe('no')
      expect(fields['o:tracking-opens']).toBe('no')

      // ── the plain part ──
      const textTokens = tokensIn(fields.text)
      expect(textTokens.length, 'the text part carries the link exactly once').toBe(1)
      const raw = textTokens[0]
      const url = `${PINNED_BASE_URL}/magic/${raw}`
      expect(fields.text, 'the URL is built from the PUBLIC_BASE_URL pin, not the request Origin').toContain(url)
      expect(fields.text, 'the pin beat the allowlisted request Origin').not.toContain(ALLOWED_ORIGIN)
      // The §UC-ML-004 copy, verbatim (vy-form, no gendered participle addressing the
      // reader — "nežiadali", not "nežiadal si"). Asserted sentence by sentence rather
      // than as one `===`, because a multipart encoder may normalise the newline.
      expect(fields.text.startsWith(`Dobrý deň, na prihlásenie do Podpultovky použite tento odkaz: ${url}`)).toBe(true)
      expect(fields.text).toContain(
        'Odkaz platí 15 minút a dá sa použiť len raz. Ak ste o prihlásenie nežiadali, tento e-mail ignorujte - vaše heslo sa nezmenilo.'
      )

      // ── the html part ──
      expect(fields.html, 'renderEmail produced the branded shell').toContain('<!DOCTYPE html>')
      expect(fields.html, 'the branded text wordmark').toContain('POD<span')
      expect(fields.html).toContain(`href="${url}"`)
      // Three occurrences of the token (text part aside): the button href, the button
      // label (URL-as-label default) and the plain-URL line under it — all the SAME
      // token, which is itself the assertion.
      const htmlTokens = tokensIn(fields.html)
      expect(htmlTokens.length, 'the html carries the link').toBeGreaterThanOrEqual(2)
      expect(new Set(htmlTokens).size, 'every occurrence is the same token').toBe(1)
      expect(htmlTokens[0], 'text and html agree on the token').toBe(raw)

      // No OTHER http(s) host anywhere in the html (08 §UC-EM-005 item 3) — a remote
      // subresource or a stray CDN link would break the no-remote-assets rule.
      const hosts = new Set([...fields.html.matchAll(/https?:\/\/[^"'\s<>)]+/g)].map((m) => new URL(m[0]).origin))
      expect([...hosts], 'the only origin in the mail is the pinned one').toEqual([PINNED_BASE_URL])

      // ── the token at rest ──
      expect(raw, 'raw token is 64 lowercase hex').toMatch(/^[a-f0-9]{64}$/)
      const rows = outstandingRows(backend.dbPath, friend.id)
      expect(rows.length, 'exactly one outstanding row').toBe(1)
      expect(rows[0].token_hash, 'stored hash is sha256(raw), never the raw token').toBe(
        crypto.createHash('sha256').update(raw).digest('hex')
      )
      expect(rows[0].token_hash).not.toBe(raw)
      expect(rows[0].used_at, 'NULL used_at = outstanding').toBe(null)
      const ttl = Number(rows[0].expires_at) - Number(rows[0].created_at)
      expect(ttl, 'the 15-minute TTL from LOGIN_TOKEN_TTL_MS').toBe(15 * 60 * 1000)

      // ⚠ The raw token must not reach the log either.
      expect(backend.logs(), 'the raw token is never logged').not.toContain(raw)
      // And the boot line reports the pin that produced it (08 §UC-EM-004).
      expect(backend.logs(), 'the PUBLIC_BASE_URL boot line names the pin').toContain(
        `[mail] PUBLIC_BASE_URL=${PINNED_BASE_URL}`
      )
      }
    )
  })

  test('cooldown, predecessor invalidation and the opportunistic GC', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withMailHarness(MAIL_ENV, async ({ stub, backend, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()
      const friend = await api.fullFriend('cooldown', uniq)

      // ── request #1 ──
      expect(await (await api.request(friend.username)).text()).toBe(NEUTRAL_BODY)
      await waitForStubCalls(stub, 1, 'the first request mails')
      const first = tokensIn(multipartFields(stub.requests[0]).text)[0]
      const rowsAfterFirst = outstandingRows(backend.dbPath, friend.id)
      expect(rowsAfterFirst.length, 'one outstanding row').toBe(1)

      // ── request #2, immediately: the 60 s cooldown ──
      // Same neutral 200, no second mail, and the stored row is untouched (a second
      // token minted-then-discarded would still have rotated the row).
      const second = await api.request(friend.email)
      expect(second.status()).toBe(200)
      expect(await second.text(), 'the cooldown is invisible in the response').toBe(NEUTRAL_BODY)
      await expectNoFurtherCalls(stub, 1)
      expect(
        outstandingRows(backend.dbPath, friend.id),
        'the cooldown writes NOTHING — same row, same hash, same timestamps'
      ).toEqual(rowsAfterFirst)

      // ── age the row past the cooldown, plus plant an EXPIRED row to be collected ──
      // An expired row belonging to ANOTHER friend — the opportunistic GC is
      // table-wide, exactly like createFriendSession's.
      const other = await api.fullFriend('gc', uniq)
      const db = new DatabaseSync(backend.dbPath)
      let plantedId
      try {
        db.prepare('UPDATE login_tokens SET created_at = ? WHERE id = ?').run(Date.now() - 61_000, rowsAfterFirst[0].id)
        db.prepare(
          'INSERT INTO login_tokens (friend_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)'
        ).run(other.id, `deadbeef${uniq}`, Date.now() - 5_000, Date.now() - 20_000)
        plantedId = Number(db.prepare('SELECT id FROM login_tokens ORDER BY id DESC LIMIT 1').get().id)
      } finally {
        db.close()
      }

      // ── request #3: past the cooldown ──
      expect(await (await api.request(friend.username)).text()).toBe(NEUTRAL_BODY)
      await waitForStubCalls(stub, 2, 'past the cooldown, a second link is mailed')
      const third = tokensIn(multipartFields(stub.requests[1]).text)[0]
      expect(third, 'a fresh token, not a re-send of the first').not.toBe(first)

      // §UC-ML-009 rule 1: at most ONE redeemable link exists per friend at any moment.
      const rowsAfterThird = outstandingRows(backend.dbPath, friend.id)
      expect(rowsAfterThird.length, 'the predecessor row was deleted, not accumulated').toBe(1)
      expect(rowsAfterThird[0].token_hash, 'the surviving row is the NEWEST token').toBe(
        crypto.createHash('sha256').update(third).digest('hex')
      )
      expect(rowsAfterThird[0].token_hash, "the first mail's token is gone from the table").not.toBe(
        crypto.createHash('sha256').update(first).digest('hex')
      )

      // ⚠ The opportunistic GC — no scheduler exists in this stack and none is added,
      // so ML-T7 relies on this staying here.
      const check = new DatabaseSync(backend.dbPath)
      try {
        const planted = check.prepare('SELECT id FROM login_tokens WHERE id = ?').get(plantedId)
        expect(planted, 'the expired row was garbage-collected by the request').toBeFalsy()
      } finally {
        check.close()
      }
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ML-T3 · 09 §UC-ML-005 — REDEMPTION
// ═════════════════════════════════════════════════════════════════════════════
//
// The two properties this half exists to hold, and what pins each:
//
//  1. THE ATOMIC SINGLE-USE WRITE. `UPDATE login_tokens SET used_at = ? WHERE
//     token_hash = ? AND used_at IS NULL AND expires_at > ?` — the `used_at IS NULL`
//     predicate INSIDE the write IS the mechanism, never a read-then-write pair. What
//     a test can see of it: a second redeem of the same token fails, and the row it
//     failed on carries the FIRST redemption's `used_at`.
//  2. ONE NEUTRAL FAILURE — one status, one message, for unknown / expired / used /
//     inactive / ineligible / legacy-mode / malformed / over-length. Pinned by
//     collecting every class's raw body into one array and asserting a single distinct
//     value, which is stronger than N independent comparisons against a literal: it
//     also catches a future class that answers differently from all the others.
//
// ⚠ Note the deliberate asymmetry with the REQUEST endpoint above: there a malformed
// body is a 400 with a `field` marker; here it is the same 401 as everything else,
// because on this endpoint the input IS the secret and "your token is the wrong shape"
// is already a statement about it.

test.describe('UC-ML-005 — redemption failure shape (shared server, mode-independent)', () => {
  let ctx
  let api

  test.beforeEach(async () => {
    ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
    api = makeApi(ctx, adminToken)
  })

  test.afterEach(async () => {
    await ctx.dispose()
  })

  test('a malformed token is the SAME neutral 401 — never a 400, never a 500', async () => {
    // ⚠ ML-T1's handover: `hashLoginToken` throws a TypeError on a non-string, so the
    // type/length guard has to run BEFORE the hash or every one of these becomes a 500
    // with a stack — a difference an attacker can steer into.
    const bodies = []
    for (const value of [5, null, true, {}, [], ['a'], { toString: null }, '']) {
      const res = await api.redeem(value)
      bodies.push(await expectNeutral401(res, `token = ${JSON.stringify(value)}`))
      expect(await res.text(), 'no stack trace leaked').not.toContain('    at ')
    }
    const absent = await ctx.post('/api/magic-link/redeem', { data: {} })
    bodies.push(await expectNeutral401(absent, 'absent token'))

    expectOneNeutralShape(bodies, 'every malformed shape')
  })

  test('an over-length token is the same neutral 401 (128 is the bound, not a 400)', async () => {
    const bodies = []
    bodies.push(await expectNeutral401(await api.redeem('a'.repeat(200)), '200 chars'))
    bodies.push(await expectNeutral401(await api.redeem('b'.repeat(129)), '129 chars'))
    // Non-vacuity: 128 is INSIDE the bound and still fails — for the ordinary reason
    // (no such token), with the identical body. The bound is not what refuses it.
    bodies.push(await expectNeutral401(await api.redeem('c'.repeat(128)), '128 chars'))
    expectOneNeutralShape(bodies, 'over/at/under the length bound')
  })

  test('a well-formed but unknown 64-hex token is the same neutral 401', async () => {
    const res = await api.redeem(crypto.randomBytes(32).toString('hex'))
    const body = await expectNeutral401(res, 'unknown 64-hex token')
    expect(body).toBe(NEUTRAL_401_BODY)
  })

  test('the endpoint is public — an anonymous caller reaches it', async () => {
    const anon = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      const res = await anon.post('/api/magic-link/redeem', { data: { token: 'd'.repeat(64) } })
      expect(await expectNeutral401(res, 'anonymous caller')).toBe(NEUTRAL_401_BODY)
      expect(res.headers()['content-type'] || '').toContain('application/json')
    } finally {
      await anon.dispose()
    }
  })

  test('no redemption response ever carries a session token or a 64-hex string', async () => {
    const body = await (await api.redeem('e'.repeat(64))).text()
    expect(body, 'a failure hands back nothing at all').not.toMatch(/[a-f0-9]{64}/)
  })
})

test.describe('UC-ML-005 — redemption (throwaway backend, modern mode)', () => {
  test('the captured token redeems ONCE: login-shaped 200, a 24 h session, a working Bearer', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withMailHarness(MAIL_ENV, async ({ stub, backend, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()
      const friend = await api.cleanFriend('redeem', uniq)

      const token = await captureToken(api, stub, friend.username)

      const before = Date.now()
      const res = await api.redeem(token)
      expect(res.status(), 'the happy path').toBe(200)
      const body = await res.json()

      // ⚠ The 200 MIRRORS `POST /friends/auth`'s personal branch so the frontend can
      // reuse its login handling verbatim, plus `viaMagicLink`. ML-T6 keys off this.
      expect(Object.keys(body).sort()).toEqual(
        ['expiresAt', 'friend', 'hasCredentials', 'mustChangePassword', 'success', 'token', 'viaMagicLink']
      )
      expect(body.success).toBe(true)
      expect(body.hasCredentials).toBe(true)
      expect(body.viaMagicLink, 'the provenance flag ML-T6 keys off').toBe(true)
      expect(body.mustChangePassword, 'this friend already chose their own password').toBe(false)

      // ⚠ HAND-PICKED FIELDS, never `SELECT *` (07 §UC-IA-005). A raw-text sweep as
      // well as the key set, so a later `SELECT *` fails loudly rather than quietly.
      expect(Object.keys(body.friend).sort()).toEqual(['id', 'name', 'packeta_address', 'uid', 'username'])
      expect(body.friend.id).toBe(friend.id)
      expect(body.friend.username).toBe(friend.username)
      expect(await res.text()).not.toMatch(/invite_code|access_token|password_hash|google_sub|email/)

      // 24 h — no remember opt-in at redemption (resolved by the product owner
      // 2026-08-15: the page never offers the checkbox).
      expect(body.expiresAt - before).toBeGreaterThan(DAY_MS - 60_000)
      expect(body.expiresAt - before).toBeLessThan(DAY_MS + 60_000)

      // The minted Bearer is a REAL session: it passes an owner-scoped call.
      const profile = await ctx.get(`/api/friends/${friend.id}/profile`, {
        headers: { Authorization: `Bearer ${body.token}` },
      })
      expect(profile.status(), 'the minted Bearer authenticates').toBe(200)
      expect((await profile.json()).id).toBe(friend.id)

      // Storage side: the row is burned, and the session carries the provenance.
      const rows = outstandingRows(backend.dbPath, friend.id)
      expect(rows.length, 'the row is kept, not deleted').toBe(1)
      expect(rows[0].token_hash).toBe(sha256(token))
      expect(rows[0].used_at, '`used_at` was stamped by the UPDATE itself').toBeTruthy()
      const usedAt = rows[0].used_at

      // ⚠ Scoped to `via = 'magic_link'`, NOT to "the friend has one session": the
      // fixture's own password change already re-minted a (NULL-`via`) session, and a
      // redemption does not invalidate other devices. Counting all rows here would be
      // asserting the fixture, not the feature.
      const magicSessions = () => withDb(backend.dbPath, (db) =>
        db.prepare("SELECT token FROM friend_sessions WHERE friend_id = ? AND via = 'magic_link'")
          .all(friend.id))
      expect(magicSessions().length, 'exactly one magic-link session was minted').toBe(1)
      expect(magicSessions()[0].token).toBe(body.token)
      // Non-vacuity for the `via` write: the fixture's password-login re-mint is right
      // beside it and carries NULL, so "one magic_link row" is a real discrimination.
      expect(
        withDb(backend.dbPath, (db) =>
          db.prepare('SELECT COUNT(*) AS n FROM friend_sessions WHERE friend_id = ? AND via IS NULL')
            .get(friend.id).n),
        'the password-login session beside it still carries NULL `via`'
      ).toBeGreaterThan(0)

      // ── SINGLE USE ──────────────────────────────────────────────────────────
      const second = await api.redeem(token)
      expect(
        await expectNeutral401(second, 'a second redemption of the same token'),
        'a spent token is refused with the SAME sentence as an unknown one'
      ).toBe(NEUTRAL_401_BODY)
      const afterSecond = outstandingRows(backend.dbPath, friend.id)
      expect(
        afterSecond[0].used_at,
        'the failed second attempt did not re-stamp the row — the predicate refused the write'
      ).toBe(usedAt)
      expect(magicSessions().length, 'and it minted no second session').toBe(1)
    })
  })

  test('a `must_change_password` friend redeems with the flag set (the forced gate, not new gate code)', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withMailHarness(MAIL_ENV, async ({ stub, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()

      // `fullFriend` sets the password via the ADMIN reset route, so this friend is in
      // the forced-change state — exactly the resolved-conflict-#4 case: the link logs
      // them in and 03 §UC-FL-012's existing gate appears.
      const friend = await api.fullFriend('forced', uniq)
      const token = await captureToken(api, stub, friend.username)

      const body = await (await api.redeem(token)).json()
      expect(body.mustChangePassword, 'the forced flow wins over the magic-link prompt').toBe(true)
      expect(body.viaMagicLink).toBe(true)
    })
  })

  test('every failure class returns the byte-identical neutral 401', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withMailHarness(MAIL_ENV, async ({ stub, backend, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()

      const bodies = []

      // (1) expired — manufactured by writing `expires_at`, never by waiting 15
      //     minutes and never by adding a TTL env knob (§UC-ML-010 obligation 2).
      const expiredFriend = await api.cleanFriend('expired', uniq)
      const expiredToken = await captureToken(api, stub, expiredFriend.username)
      withDb(backend.dbPath, (db) =>
        db.prepare('UPDATE login_tokens SET expires_at = ? WHERE token_hash = ?')
          .run(Date.now() - 1000, sha256(expiredToken)))
      bodies.push(await expectNeutral401(await api.redeem(expiredToken), 'expired token'))
      expect(
        outstandingRows(backend.dbPath, expiredFriend.id)[0].used_at,
        'an expired token is NOT burned — the `expires_at >` predicate refused the write'
      ).toBeFalsy()

      // (2) the friend was deactivated after the link was issued.
      //     ⚠ The token IS burned first even here — deliberate: a token that reached
      //     an ineligible account must not stay redeemable.
      const goneFriend = await api.cleanFriend('gone', uniq)
      const goneToken = await captureToken(api, stub, goneFriend.username)
      await api.deactivate(goneFriend.id)
      bodies.push(await expectNeutral401(await api.redeem(goneToken), 'deactivated friend'))
      expect(
        outstandingRows(backend.dbPath, goneFriend.id)[0].used_at,
        'burned anyway — an ineligible account must not leave a redeemable token behind'
      ).toBeTruthy()
      expect(
        withDb(backend.dbPath, (db) =>
          db.prepare("SELECT COUNT(*) AS n FROM friend_sessions WHERE friend_id = ? AND via = 'magic_link'")
            .get(goneFriend.id).n),
        'and no magic-link session was minted for the inactive friend'
      ).toBe(0)

      // (3) already used
      const usedFriend = await api.cleanFriend('used', uniq)
      const usedToken = await captureToken(api, stub, usedFriend.username)
      expect((await api.redeem(usedToken)).status()).toBe(200)
      bodies.push(await expectNeutral401(await api.redeem(usedToken), 'already-used token'))

      // (4) unknown / malformed / over-length, on the same server as the rest
      bodies.push(await expectNeutral401(await api.redeem(crypto.randomBytes(32).toString('hex')), 'unknown'))
      bodies.push(await expectNeutral401(await api.redeem(42), 'non-string'))
      bodies.push(await expectNeutral401(await api.redeem('f'.repeat(500)), 'over-length'))

      // (5) LEGACY MODE — a perfectly valid, outstanding token still fails. This is
      //     the only place the mode gate can be exercised with a REAL token: the
      //     shared server may never be flipped, and a legacy-mode request writes no
      //     row to redeem.
      const legacyFriend = await api.cleanFriend('legacy', uniq)
      const legacyToken = await captureToken(api, stub, legacyFriend.username)
      await api.setLegacyMode()
      bodies.push(await expectNeutral401(await api.redeem(legacyToken), 'legacy mode'))
      expect(
        outstandingRows(backend.dbPath, legacyFriend.id)[0].used_at,
        'the mode gate runs BEFORE the write — the token survives a legacy-mode attempt'
      ).toBeFalsy()

      // ⚠ THE cross-class assertion, and it is load-bearing precisely because
      // `expectNeutral401` no longer compares bodies to the literal: each of the seven
      // classes above could have answered 401-with-one-key and a DIFFERENT sentence,
      // and only this catches it.
      expectOneNeutralShape(bodies, 'all seven failure classes')
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ML-T3 · the `/magic/:token` PAGE
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠ REDEMPTION IS A POST FIRED BY THE PAGE'S JS, NEVER A GET SIDE EFFECT. Corporate
// mail scanners and link-prefetchers (the Outlook SafeLinks class) follow GET links; if
// the SPA document GET burned the token, the human's click would always land on
// "already used". So the assertions below are about the POST: that the document GET
// alone changes nothing, that exactly ONE POST is fired per visit, and that a re-visit
// of the same token does not fire a second one.

test.describe('UC-ML-005 — the /magic/:token page (shared server, terminal state)', () => {
  // The shared server is LEGACY, so every token — well-formed or not — takes the
  // neutral-failure branch for real. That makes this the honest end-to-end test of the
  // failure page: no stub, no fixture, the server's own 401.

  test('the document GET alone redeems nothing — the POST is what does', async ({ page }) => {
    let posts = 0
    await page.route('**/api/magic-link/redeem', (route) => {
      posts += 1
      return route.continue()
    })

    await page.goto(`/magic/${'a'.repeat(64)}`)
    await expect(page.getByTestId('magic-failed')).toBeVisible()
    expect(posts, 'exactly one POST — and it came from the page, not from the navigation').toBe(1)

    // No auto-retry loop: give it a beat and prove nothing else fired.
    await page.waitForTimeout(1500)
    expect(posts, 'no retry loop').toBe(1)
  })

  test('the failure page shows the neutral message and the way back', async ({ page }) => {
    await page.goto(`/magic/${'b'.repeat(64)}`)

    const card = page.getByTestId('magic-failed')
    await expect(card).toBeVisible()
    // ⚠ `innerText` applies `text-transform`, and this card's headline is uppercase —
    // so the MESSAGE is asserted on its own element with `toHaveText` (textContent,
    // untransformed) rather than swept out of the card's innerText.
    await expect(page.getByTestId('magic-error')).toHaveText(
      'Odkaz na prihlásenie už nie je platný. Požiadajte o nový na prihlasovacej obrazovke.'
    )

    // Nothing was stored — a failed redemption must not leave a half-session behind.
    expect(await page.evaluate(() => localStorage.getItem('gorifi_friend_auth'))).toBeNull()

    await page.getByRole('button', { name: 'Späť na prihlásenie' }).click()
    await expect(page).toHaveURL(`${BASE_URL}/`)
  })

  test('the single-shot guard survives an IN-SPA re-navigation to the same token', async ({ page }) => {
    // ⚠ THE GUARD IS MODULE-SCOPE, so what it protects against is a re-MOUNT inside one
    // document — Back, or any in-SPA route change that returns here. A fresh document
    // load legitimately re-attempts (new module state, and the server is the real
    // single-use authority anyway); the case that must never happen is one page session
    // firing the same single-use credential twice.
    let posts = 0
    await page.route('**/api/magic-link/redeem', (route) => {
      posts += 1
      return route.continue()
    })

    await page.goto(`/magic/${'d'.repeat(64)}`)
    await expect(page.getByTestId('magic-failed')).toBeVisible()
    expect(posts).toBe(1)

    await page.getByRole('button', { name: 'Späť na prihlásenie' }).click()
    await expect(page).toHaveURL(`${BASE_URL}/`)

    // Back — a history pop, handled by vue-router without a document load.
    await page.goBack()
    await expect(page.getByTestId('magic-failed')).toBeVisible()
    expect(posts, 'the guard held — no second POST for a token already attempted').toBe(1)
  })

  // ⚠ THE PAGE HAS EXACTLY ONE FAILURE VOCABULARY — it renders its own constant, never
  // the thrown error's `.message`. `api.js`'s `request()` ALWAYS throws an Error with a
  // non-empty message, so an `e?.message || NEUTRAL` fallback is unreachable and the
  // page rendered raw English ("Failed to fetch") or the wrong sentence ("Chyba
  // servera", a limiter message) on a public Slovak screen — to someone who by
  // definition cannot log in, with no retry affordance. Without this test the fix is a
  // one-token change nothing would notice being reverted.
  for (const [label, handler] of [
    ['a dead network', (route) => route.abort()],
    ['a 500 from the server', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Chyba servera' }),
    })],
    ['a 429 with a limiter message', (route) => route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Príliš veľa pokusov. Skúste to neskôr.' }),
    })],
  ]) {
    test(`${label} still renders the ONE neutral sentence, not the error's own`, async ({ page }) => {
      await page.route('**/api/magic-link/redeem', handler)
      await page.goto(`/magic/${'e'.repeat(64)}`)

      await expect(page.getByTestId('magic-error')).toHaveText(
        'Odkaz na prihlásenie už nie je platný. Požiadajte o nový na prihlasovacej obrazovke.'
      )
      // Explicit absences: these are the exact strings the unreachable-fallback bug put
      // on screen, and a passing text assertion above would not by itself prove they
      // are gone if the copy were ever appended rather than replaced.
      const card = page.getByTestId('magic-failed')
      await expect(card).not.toContainText('Failed to fetch')
      await expect(card).not.toContainText('Chyba servera')
      await expect(card).not.toContainText('Príliš veľa pokusov')
      await expect(card.getByRole('button', { name: 'Späť na prihlásenie' })).toBeVisible()
    })
  }

  test('the mounting state announces itself while the POST is in flight', async ({ page }) => {
    await page.route('**/api/magic-link/redeem', async (route) => {
      await new Promise((r) => setTimeout(r, 1200))
      return route.continue()
    })
    await page.goto(`/magic/${'c'.repeat(64)}`)
    await expect(page.getByTestId('magic-verifying')).toBeVisible()
    await expect(page.getByTestId('magic-verifying')).toHaveText('Overujem odkaz...')
    await expect(page.getByTestId('magic-failed')).toBeVisible()
  })
})

test.describe('UC-ML-005 — the /magic/:token page, full flow (throwaway backend)', () => {
  test('clicking the mailed link logs the friend in — and replaces whoever was signed in', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withMailHarness(MAIL_ENV, async ({ stub, backend, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()

      const alice = await api.cleanFriend('alice', uniq)
      const bob = await api.cleanFriend('bob', uniq)

      let posts = 0
      await page.route('**/api/magic-link/redeem', (route) => {
        posts += 1
        return route.continue()
      })

      // ── Alice is already signed in on this device ────────────────────────────
      const aliceAuth = await api.passwordLogin(alice.username, CHOSEN_PASSWORD)
      await page.goto(`${backend.baseUrl}/`)
      await page.evaluate((payload) => {
        localStorage.setItem('gorifi_friend_auth', payload)
      }, JSON.stringify({
        friendId: alice.id,
        friendName: alice.name,
        friendUid: alice.uid,
        token: aliceAuth.token,
        expiresAt: aliceAuth.expiresAt,
        // ⚠ A SIBLING FLAG THAT ONLY ALICE SET. This is what makes the overwrite rule
        // discriminating: every OTHER key is written by the redemption anyway, so a
        // merge (`{...old, ...fresh}`) would look identical on all of them and only
        // this one would betray it. `magicPromptDismissed` is not a hypothetical —
        // it is the flag ML-T6 persists here, and inheriting Alice's dismissal would
        // silently suppress Bob's prompt on his very first magic-link login.
        magicPromptDismissed: true,
      }))
      await page.goto(`${backend.baseUrl}/`)
      await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()

      // ── Bob's link is clicked on Alice's device ──────────────────────────────
      const token = await captureToken(api, stub, bob.username)
      await page.goto(`${backend.baseUrl}/magic/${token}`)

      // Success replaces the page with the portal — `router.replace('/')`.
      await expect(page).toHaveURL(`${backend.baseUrl}/`)
      await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
      expect(posts, 'one POST per visit, fired by the page').toBe(1)

      // ⚠ THE SIX-LEAK SURFACE. Clicking a valid login link means "log in as this
      // link's owner", including when the device held someone else's session — so
      // NOTHING of Alice may survive. Asserted on the whole storage blob, not just on
      // the fields we happen to rewrite.
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gorifi_friend_auth') || 'null'))
      expect(stored, 'a session was stored').toBeTruthy()
      expect(stored.friendId).toBe(bob.id)
      expect(stored.friendName).toBe(bob.name)
      expect(stored.token).not.toBe(aliceAuth.token)
      expect(stored.expiresAt - Date.now()).toBeGreaterThan(DAY_MS - 5 * 60_000)
      expect(stored.expiresAt - Date.now()).toBeLessThan(DAY_MS + 60_000)
      expect(
        stored,
        "the payload is OVERWRITTEN, not merged — none of Alice's sibling flags survive"
      ).not.toHaveProperty('magicPromptDismissed')
      expect(Object.keys(stored).sort()).toEqual(
        ['expiresAt', 'friendId', 'friendName', 'friendUid', 'token', 'viaMagicLink']
      )

      const wholeStorage = await page.evaluate(() => JSON.stringify(localStorage))
      expect(wholeStorage, "Alice's session token is gone from this device").not.toContain(aliceAuth.token)
      expect(wholeStorage, "Alice's name is gone from this device").not.toContain(alice.name)

      // The appbar renders the NEW friend, so the leak would be visible too.
      await expect(page.locator('.appbar')).toContainText(bob.name)

      // ── single use, seen from the UI ────────────────────────────────────────
      // A FRESH DOCUMENT LOAD legitimately re-attempts (new module state — the
      // in-document guard is pinned separately on the shared server above), and the
      // server refuses it. So the second click of a mailed link shows the neutral page,
      // which is the whole user-visible point of the single-use rule.
      await page.goto(`${backend.baseUrl}/magic/${token}`)
      await expect(page.getByTestId('magic-failed')).toBeVisible()
      expect(posts, 'a new document attempted once more, and was refused').toBe(2)
    })
  })

  // ⚠ THE FRONTEND HALF OF `mustChangePassword` (§UC-ML-005 / resolved conflict #4).
  // The API half is asserted above, but it never opens a browser — and the two hunks
  // that carry the flag from the 200 into 03 §UC-FL-012's gate live in
  // `FriendPortal.vue`, on the session-RESTORE path (the documented six-leak surface).
  // Deleting either left the whole suite green before this test existed:
  //
  //   · `beginSession({ mustChangePassword: !!parsed.mustChangePassword })` — without
  //     it the gate never opens, and a friend whose password an admin just reset is
  //     silently let into the app with the admin's password still live.
  //   · `onForcedComplete`'s localStorage delete — without it `must_change_password`
  //     is 0 server-side while the stored payload still says 1, so EVERY RELOAD of
  //     that session re-opens a gate the friend already satisfied. Exactly the
  //     "passes in a fresh test, rots in real use" shape. ⚠ BOTH the persisted-flag
  //     assertion below AND the reload catch this, independently — measured, after an
  //     earlier version of this comment claimed only the reload did. Neither is
  //     redundant garnish: the flag assertion names the cause, the reload pins the
  //     user-visible consequence (a satisfied gate must not re-open).
  test('a `must_change_password` friend lands in the forced gate — and it does not come back', async ({ page }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withMailHarness(MAIL_ENV, async ({ stub, backend, ctx, adminToken }) => {
      const api = makeApi(ctx, adminToken)
      const uniq = uniqTag()
      await api.setModernMode()

      // `fullFriend` sets the password through the ADMIN reset route, which raises
      // `must_change_password` — no `cleanFriend` here, deliberately.
      const friend = await api.fullFriend('uiforced', uniq)
      const token = await captureToken(api, stub, friend.username)

      const stored = () => page.evaluate(
        () => JSON.parse(localStorage.getItem('gorifi_friend_auth') || 'null'))
      const gate = page.getByTestId('forced-password-change')

      // ── redemption lands in the gate ────────────────────────────────────────
      await page.goto(`${backend.baseUrl}/magic/${token}`)
      await expect(page).toHaveURL(`${backend.baseUrl}/`)
      await expect(gate, '03 §UC-FL-012\'s EXISTING gate, reached from a magic link').toBeVisible()
      expect((await stored()).mustChangePassword, 'the flag rode in on the stored payload').toBe(true)

      // ── satisfying it clears the flag, in the DB and on the device ──────────
      const newPassword = 'magicSet12345'
      await page.locator('#pp-forced-new-password').fill(newPassword)
      await page.locator('#pp-forced-new-password-confirm').fill(newPassword)
      await gate.getByRole('button', { name: /Nastaviť heslo a pokračovať/ }).click()
      await expect(gate).toHaveCount(0)

      const afterChange = await stored()
      expect(
        afterChange,
        'the persisted flag is deleted — otherwise it outlives the server-side 0'
      ).not.toHaveProperty('mustChangePassword')
      // The re-mint really happened (the change-password path invalidates + re-mints),
      // so the cleanup is running against a payload that was just rewritten by
      // `onToken` — the ordering of the two emits matters and this pins it.
      expect(afterChange.token, 'a fresh session token was stored').toBeTruthy()

      // ── and it does not come back ───────────────────────────────────────────
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
      await expect(gate, 'a satisfied gate must not re-open on every reload').toHaveCount(0)

      // Non-vacuity for the whole test: the new password is the one that now works,
      // so the gate was a real credential change and not a dismissed dialog.
      const relogin = await ctx.post('/api/friends/auth', {
        data: { username: friend.username, password: newPassword },
      })
      expect(relogin.status(), 'the password the friend chose in the gate authenticates').toBe(200)
      expect((await relogin.json()).mustChangePassword, 'and the server flag is cleared too').toBe(false)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ML-T4 — 09 §UC-ML-007 (remember-me: checkbox semantics + the storage rule) and
// resolved conflicts #1 and #2.
//
// ⚠ APPENDED HERE for the same reason ML-T3 appended: §UC-ML-010 obligation 1 names
// this file for the UI criteria of §UC-ML-006/007/008, and ML-T2's header reserved it
// for exactly this. Nothing above this line is touched.
//
// The three behaviours this block pins, none of which existed before ML-T4:
//   1. the checkbox is UNCHECKED at rest (resolved conflict #2) — 60 days is the
//      OPT-IN, so a pre-checked box would have made it the effective default;
//   2. `remember` reaches `POST /friends/auth` from BOTH login paths — the modern
//      personal branch AND the legacy shared-password branch;
//   3. `gorifi_friend_auth` is written on EVERY successful login, checked or not
//      (resolved conflict #1 — "the TTL, not the storage, is the mechanism"), so the
//      only thing the checkbox moves is the server-issued `expiresAt`: 24 h vs 60 d.
//
// Both cards are covered because they are DIFFERENT MARKUP calling DIFFERENT api.js
// functions: the modern card's `NeoCheckbox` + `authenticateFriendsPersonal`, and the
// legacy card's native `<input type=checkbox>` + `authenticateFriends`. A change that
// only reaches the personal path leaves the legacy half silently on 24 h forever.
// ═══════════════════════════════════════════════════════════════════════════════

const AUTH_STORAGE_KEY = 'gorifi_friend_auth'
const REMEMBER_MS = 60 * DAY_MS

// The five keys three other e2e suites write into this object directly. §UC-ML-007
// freezes them; the payload MAY gain optional fields (ML-T6's flags), so this is a
// presence check, never an exact-set one.
const PINNED_STORAGE_KEYS = ['friendId', 'friendName', 'friendUid', 'token', 'expiresAt']

/** The stored session payload, or null. */
const readStored = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), AUTH_STORAGE_KEY)

/**
 * Assert the stored payload keeps its pinned shape and carries a server horizon
 * `expected` ms away. The tolerance covers the request round-trip only — it is
 * deliberately far tighter than the 24 h ↔ 60 d gap, so a horizon that silently
 * reverts to the default cannot pass as "roughly right".
 */
function expectStoredHorizon(stored, expected, label) {
  expect(stored, `${label}: localStorage MUST be written whether or not the box is ticked`)
    .not.toBeNull()
  for (const key of PINNED_STORAGE_KEYS) {
    expect(Object.keys(stored), `${label}: pinned key ${key}`).toContain(key)
  }
  expect(typeof stored.token, `${label}: a real session token`).toBe('string')
  const horizon = stored.expiresAt - Date.now()
  expect(horizon, `${label}: expiresAt ${horizon} ms out, expected ≈ ${expected}`)
    .toBeGreaterThan(expected - 10 * 60 * 1000)
  expect(horizon, `${label}: expiresAt ${horizon} ms out, expected ≈ ${expected}`)
    .toBeLessThanOrEqual(expected)
}

/**
 * Capture the `remember` field of every `POST /api/friends/auth` body.
 *
 * ⚠ Matched on the EXACT path: `/api/friends/auth-mode` is a GET on a path this
 * endpoint's name is a prefix of, and a substring match would fold the two together.
 */
function captureAuthBodies(page) {
  const bodies = []
  page.on('request', (req) => {
    if (req.method() !== 'POST') return
    if (new URL(req.url()).pathname !== '/api/friends/auth') return
    try {
      bodies.push(JSON.parse(req.postData() || '{}'))
    } catch {
      bodies.push({ unparseable: true })
    }
  })
  return bodies
}

test.describe('UC-ML-007 — remember-me is a TTL, not a storage switch', () => {
  let ctx
  let api
  let uniq

  // ⚠ No localStorage clearing here, deliberately. Playwright gives every test a fresh
  // browser context, so storage starts empty — and an `addInitScript` clear would
  // re-run on EVERY navigation, including the `page.reload()` two tests below use to
  // prove the stored session survives one. (It did: it wiped the payload and both
  // reload assertions failed for a reason that had nothing to do with the product.)
  test.beforeEach(async () => {
    ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
    uniq = uniqTag()
    const adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
    api = makeApi(ctx, adminToken)
  })

  test.afterEach(async () => {
    await ctx.dispose()
  })

  // ── the MODERN card ────────────────────────────────────────────────────────
  //
  // ⚠ The shared seed is LEGACY and must stay legacy (modern-login.spec.js documents
  // why at length: a spec that writes `auth_mode` and dies breaks the rest of the
  // suite). So the mode probe is STUBBED per page — every other request, including
  // the login itself, still hits the real backend.
  const stubModern = (page) =>
    page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'modern' } }))

  async function modernLogin(page, friend, { remember }) {
    await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
    await page.getByLabel(/^heslo$/i).fill(friend.password)
    if (remember) {
      await page.getByRole('checkbox', { name: 'Zapamätať si ma na tomto zariadení' }).click()
    }
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  }

  test('the modern card ships the box UNCHECKED at rest (resolved conflict #2)', async ({ page }) => {
    await stubModern(page)
    await page.goto('/')
    const box = page.getByRole('checkbox', { name: 'Zapamätať si ma na tomto zariadení' })
    await expect(box, '60 days is the OPT-IN — a pre-checked box makes it the default')
      .toHaveAttribute('aria-checked', 'false')
  })

  test('modern login, box UNCHECKED: localStorage IS written, with a 24 h horizon that survives a reload', async ({ page }) => {
    const friend = await api.cleanFriend('mlt4unchecked', uniq)
    const bodies = captureAuthBodies(page)
    await stubModern(page)
    await page.goto('/')
    await modernLogin(page, friend, { remember: false })

    expect(bodies, 'exactly one auth POST').toHaveLength(1)
    expect(bodies[0].remember, 'an untouched box sends a STRICT false, never undefined').toBe(false)

    const stored = await readStored(page)
    expectStoredHorizon(stored, DAY_MS, 'modern / unchecked')
    expect(stored.friendId).toBe(friend.id)

    // …and it is a REAL session, not just a written object: the reload restores it
    // instead of falling back to the login card. This is the half the retired
    // in-memory-only fallback could never do.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    const afterReload = await readStored(page)
    expect(afterReload.token, 'the restore must not rewrite the token').toBe(stored.token)
  })

  test('modern login, box CHECKED: the same storage, a 60-day horizon', async ({ page }) => {
    const friend = await api.cleanFriend('mlt4checked', uniq)
    const bodies = captureAuthBodies(page)
    await stubModern(page)
    await page.goto('/')
    await modernLogin(page, friend, { remember: true })

    expect(bodies).toHaveLength(1)
    expect(bodies[0].remember, 'the ticked box is what buys 60 days').toBe(true)
    expectStoredHorizon(await readStored(page), REMEMBER_MS, 'modern / checked')
  })

  // ── the LEGACY shared-password card ────────────────────────────────────────
  //
  // No stub at all: the shared server IS legacy, so this is the card an anonymous
  // visitor actually gets. It is the half most likely to be forgotten, because it
  // goes through a different api.js function (`authenticateFriends`).
  async function legacyLogin(page, { remember }) {
    await page.getByRole('combobox').click()
    await page.getByRole('option', { name: FRIEND_NAME }).click()
    await page.getByPlaceholder('Zadajte heslo').fill(FRIENDS_PASSWORD)
    if (remember) {
      await page.getByRole('checkbox', { name: /Zapamätať si ma na tomto zariadení/ }).check()
    }
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  }

  test('the legacy card ships the box UNCHECKED at rest too — one ref, both cards', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Prihlásenie')).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /Zapamätať si ma na tomto zariadení/ }))
      .not.toBeChecked()
  })

  test('legacy shared-password login, box UNCHECKED: localStorage written, 24 h horizon', async ({ page }) => {
    const bodies = captureAuthBodies(page)
    await page.goto('/')
    await legacyLogin(page, { remember: false })

    expect(bodies, 'exactly one auth POST').toHaveLength(1)
    expect(bodies[0].friendId, 'the legacy branch — identified by friendId, not username').toBeTruthy()
    expect(bodies[0].remember, 'the LEGACY path sends it too').toBe(false)
    expectStoredHorizon(await readStored(page), DAY_MS, 'legacy / unchecked')

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  })

  test('legacy shared-password login, box CHECKED: 60-day horizon', async ({ page }) => {
    const bodies = captureAuthBodies(page)
    await page.goto('/')
    await legacyLogin(page, { remember: true })

    expect(bodies).toHaveLength(1)
    expect(bodies[0].remember).toBe(true)
    expectStoredHorizon(await readStored(page), REMEMBER_MS, 'legacy / checked')
  })

  // ── the on-device half of the split (03 §UC-FL-001, unchanged by this row) ──
  test('a stored payload whose expiresAt has PASSED still falls back to the login screen', async ({ page }) => {
    // Written directly, exactly as ~20 fixtures across the suite do — the pinned
    // shape, with a horizon 24 h in the PAST. Always storing the payload must not
    // turn a lapsed 24 h session into a permanent one.
    await page.addInitScript(
      ([key, payload]) => localStorage.setItem(key, payload),
      [
        AUTH_STORAGE_KEY,
        JSON.stringify({
          friendId: 1,
          friendName: 'Expired Fixture',
          friendUid: 'EXPIRED1',
          token: 'a'.repeat(64),
          expiresAt: Date.now() - DAY_MS,
        }),
      ]
    )
    await page.goto('/')

    await expect(page.getByText('Prihlásenie')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toHaveCount(0)
    expect(await readStored(page), 'the lapsed payload is dropped, not kept').toBeNull()
  })
})
