// ML-T2 — 09 §UC-ML-003 (the enumeration-safe request endpoint), §UC-ML-004 (the
// magic-link mail) and §UC-ML-009 rule 1 (a new request invalidates its predecessors).
//
// ⚠ REDEMPTION IS ML-T3's. This file covers the REQUEST half only; ML-T3 appends its
// capture → redeem → authenticated-call tests here (§UC-ML-010 obligation 1 names this
// exact filename for the full-flow spec), and ML-T7 appends the invalidation matrix.
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
import { ADMIN_PASSWORD } from '../fixtures.js'
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
