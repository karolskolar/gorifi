import { test, expect, request as playwrightRequest } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeAdmin, loginAdmin } from '../helpers/admin.js'
import { stripComments } from '../helpers/source-pins.js'

// FUP-T27 — THE DETERMINISTIC REPRODUCTION OF THE ONE-ADMIN-TOKEN DEFECT.
//
// ⚠⚠ THIS FILE IS THE ROW'S DELIVERABLE, not `helpers/admin.js`. The defect it covers
// was diagnosed from a full-suite failure that would not reproduce on demand: two
// coordinator runs of the same tree went 115-failed and 33-failed on a LOADED box and
// 0-failed on an idle one (docs/learnings/10-portal-ia.md §10). A harness fix validated
// only by „the suite went green once" is unfalsifiable — so the mechanism is rotated
// here DELIBERATELY, from a second request context, and the recovery is asserted.
//
// The mechanism, in one line: the backend keeps ONE `admin_token` row and every
// `POST /api/admin/login` REPLACES it, so any login anywhere — including one whose
// response lands after its own test already timed out — kills every token the suite
// cached earlier.
//
// Four properties, in the order they have to be believed:
//   §1  THE DEFECT ITSELF — a cached token 401s after somebody else logs in. This is the
//       non-vacuity gate for everything below: without it, §2 proves only that a
//       working token works.
//   §2  THE RECOVERY — the same rotation, through `makeAdmin()`, succeeds, in exactly
//       ONE re-login, and the refreshed token is published back to the caller.
//   §3  ONE RETRY, NOT A LOOP — a 401 that re-authentication cannot fix is returned
//       unchanged after a single login attempt.
//   §4  THE EXCLUSION — the retry, applied to `api-security.spec.js`'s staleness
//       assertion, turns its 401 into a 200 and deletes the test's meaning. Pinned as a
//       live demonstration plus a source pin, because „remember not to adopt it there"
//       is not a guard.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const HERE = dirname(fileURLToPath(import.meta.url))
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// `ctx` plays „a spec file that logged in during its own beforeAll"; `rotator` plays
// „some other spec file (or a timed-out UI login) that logs in later".
let ctx
let rotator
let adminToken
let logins = 0

/**
 * A view of `ctx` that COUNTS admin logins. The retry's whole contract is „exactly
 * once", and a count is the only way to assert the difference between one retry and a
 * loop that happens to terminate.
 */
function countingCtx(target) {
  return new Proxy(target, {
    get(obj, prop) {
      const value = obj[prop]
      if (typeof value !== 'function') return value
      return (...args) => {
        if (prop === 'post' && String(args[0]) === '/api/admin/login') logins += 1
        return value.apply(obj, args)
      }
    },
  })
}

/** Rotate the single `admin_token` row from ANOTHER context — the real mechanism. */
async function rotateFromElsewhere() {
  const token = await loginAdmin(rotator)
  expect(token, 'the rotation minted a token').toBeTruthy()
  return token
}

// The shape every one of the 42 adopting files used BEFORE this row: a cached token,
// no retry. Kept here on purpose — §1 needs the defect to still be reproducible after
// the fix, or the fix is unfalsifiable.
async function cachedAdmin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data !== undefined ? { data: opts.data } : {}),
  })
}

// ⚠ NOT `mode: 'serial'`. The tests share `adminToken` and run in order anyway
// (`fullyParallel: false`), but serial mode SKIPS the rest of the file after the first
// failure — which would have hidden half of this row's mutation blast radius. Every
// test below either re-establishes the token it needs or recovers through the helper.

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  rotator = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminToken = await loginAdmin(ctx)
})

test.afterAll(async () => {
  await ctx?.dispose()
  await rotator?.dispose()
})

// ---------------------------------------------------------------------------
// §1 — THE DEFECT, REPRODUCED ON DEMAND

test.describe('FUP-T27 §1 — the defect: a cached admin token dies when anything else logs in', () => {
  test('a fixture POST that worked a moment ago 401s after a login from another context', async () => {
    // Non-vacuity, and it matters: the 401 below has to be about the ROTATION, not
    // about a token that was never any good.
    const before = await cachedAdmin('/api/friends', {
      method: 'post', data: { name: `FUP27 before ${uniq}` },
    })
    expect(before.status(), 'the cached token is live to begin with').toBe(201)

    const live = await rotateFromElsewhere()

    // ⚠ THIS IS THE CASCADE, one file deep: exactly the `POST /api/friends` 401 that
    // showed up in fifteen files during PI-T3's red runs.
    const after = await cachedAdmin('/api/friends', {
      method: 'post', data: { name: `FUP27 after ${uniq}` },
    })
    expect(after.status(), 'the cached token is dead — ONE row, replaced').toBe(401)

    // And the row is not merely gone: somebody else owns it now.
    const byLive = await ctx.get('/api/friends', { headers: { 'X-Admin-Token': live } })
    expect(byLive.status(), 'the rotation’s own token is the live one').toBe(200)

    adminToken = live
  })
})

// ---------------------------------------------------------------------------
// §2 — THE RECOVERY

test.describe('FUP-T27 §2 — makeAdmin() re-authenticates ONCE and carries on', () => {
  test('the same rotation that reds §1 is survived, in exactly one re-login', async () => {
    const admin = makeAdmin({
      ctx: () => countingCtx(ctx),
      token: () => adminToken,
      adopt: (t) => { adminToken = t },
    })

    const stale = adminToken
    await rotateFromElsewhere()
    logins = 0

    const res = await admin('/api/friends', { method: 'post', data: { name: `FUP27 retry ${uniq}` } })
    expect(res.status(), 'the fixture POST succeeds through the rotation').toBe(201)
    expect(logins, 'exactly ONE re-authentication — never a loop').toBe(1)

    // ⚠ `adopt` is the half that makes this useful to a whole spec FILE rather than to
    // one call: the file's own `adminToken` — used for `localStorage` seeding and raw
    // `ctx.*` headers elsewhere — must now be the live one.
    expect(adminToken, 'the refreshed token was published back to the caller').not.toBe(stale)
    const raw = await ctx.get('/api/friends', { headers: { 'X-Admin-Token': adminToken } })
    expect(raw.status(), 'and the published token really is live').toBe(200)
  })

  test('a call that needs no retry makes no login at all', async () => {
    const admin = makeAdmin({
      ctx: () => countingCtx(ctx),
      token: () => adminToken,
      adopt: (t) => { adminToken = t },
    })

    logins = 0
    const res = await admin('/api/friends')
    expect(res.status()).toBe(200)
    expect(logins, 'a healthy token is not re-minted — the row would rotate for nothing').toBe(0)
  })

  test('`reauth: false` opts one call out — the raw answer of a token made stale', async () => {
    const admin = makeAdmin({
      ctx: () => countingCtx(ctx),
      token: () => adminToken,
      adopt: (t) => { adminToken = t },
    })

    const stale = adminToken
    const live = await rotateFromElsewhere()
    logins = 0

    const res = await admin('/api/friends', { reauth: false })
    expect(res.status(), 'the opt-out returns the staleness itself').toBe(401)
    expect(logins, 'and mints nothing').toBe(0)
    expect(adminToken, 'and leaves the caller’s token alone').toBe(stale)

    adminToken = live
  })
})

// ---------------------------------------------------------------------------
// §3 — ONE RETRY, NOT A LOOP

test.describe('FUP-T27 §3 — a 401 re-authentication cannot fix is returned, not looped', () => {
  test('a friend-identity route stays 401 for an admin token, after exactly one login', async () => {
    const admin = makeAdmin({
      ctx: () => countingCtx(ctx),
      token: () => adminToken,
      adopt: (t) => { adminToken = t },
    })

    // Non-vacuity: this route is 401 to an admin token by CONTRACT (`requireFriendOwner`
    // — an admin token is not friend identity, SEC-A1), not because the token is stale.
    // So a perfectly fresh token gets the same answer, and the retry must not chase it.
    logins = 0
    const res = await admin('/api/friends/1/profile')
    expect(res.status(), 'the route’s own answer reaches the test unchanged').toBe(401)
    expect(logins, 'ONE login attempt, then the answer stands').toBe(1)

    // The retry did rotate the row; the adopted token must be the live one, or this
    // test would itself become the thing it is guarding against.
    const raw = await ctx.get('/api/friends', { headers: { 'X-Admin-Token': adminToken } })
    expect(raw.status(), 'the retry’s own token was adopted').toBe(200)
  })
})

// ---------------------------------------------------------------------------
// §4 — THE EXCLUSION, DEMONSTRATED RATHER THAN PROMISED

test.describe('FUP-T27 §4 — the retry must never reach a test whose subject is auth', () => {
  test('applied to api-security’s staleness gate, the retry turns its 401 into a 200', async () => {
    // `api-security.spec.js`:
    //   expect((await request.get('/api/friends', { headers: { 'X-Admin-Token': stale } })).status(),
    //     'non-vacuity: the stale token is genuinely dead').toBe(401)
    // That line is the non-vacuity gate of „a STALE token logs out nothing". Run the
    // SAME assertion through a retrying helper and watch it evaporate.
    const stale = await loginAdmin(ctx)
    const live = await rotateFromElsewhere()
    expect(live, 'the rotation really did replace the row').not.toBe(stale)

    // The honest answer — what api-security asserts, and must keep asserting.
    const direct = await ctx.get('/api/friends', { headers: { 'X-Admin-Token': stale } })
    expect(direct.status(), 'the stale token is genuinely dead').toBe(401)

    // The same call through the helper. Nothing about the stale token changed; the
    // helper simply refuses to accept its answer.
    let adopted = stale
    const retrying = makeAdmin({
      ctx: () => ctx,
      token: () => stale,
      adopt: (t) => { adopted = t },
    })
    const viaHelper = await retrying('/api/friends')
    expect(viaHelper.status(),
      'THE POINT: a retrying helper answers 200 where the staleness test needs 401').toBe(200)
    expect(adopted, 'because it quietly minted a different token').not.toBe(stale)

    adminToken = adopted
  })

  test('api-security.spec.js does not import the retrying helper', async () => {
    const raw = readFileSync(join(HERE, 'api-security.spec.js'), 'utf8')
    const src = stripComments(raw)

    // Readability gate — an absence pin against text that was never read passes
    // trivially (the `helpers/source-pins.js` trap, applied to a spec file).
    expect(src.length / raw.length, 'the comment strip returned almost nothing').toBeGreaterThan(0.05)
    for (const token of ["'X-Admin-Token': stale", "/api/admin/logout", 'ADMIN_ENDPOINTS']) {
      expect(src, `expected \`${token}\` to survive the strip`).toContain(token)
    }

    expect(src, 'api-security.spec.js tests token staleness on purpose — see §4 above')
      .not.toContain('helpers/admin.js')
    expect(src, 'and must keep building its own headers, with no re-authentication behind them')
      .not.toContain('makeAdmin')
  })
})

// ---------------------------------------------------------------------------
// §5 — THE HELPER IS THE ONE HOME

test.describe('FUP-T27 §5 — one home, not 42 copies of a retry', () => {
  // ⚠ THE SELF-MATCH CONTROL IS THE SPLIT LITERAL BELOW, NOT THE BRACKET CLASS —
  // corrected in review (2026-09-20) after MEASURING both, because the first version of
  // this comment credited the wrong one and would have sent the next editor at the wrong
  // knob. Measured: with a plain `admin` in the pattern, the regex does NOT match its own
  // source line (after `admin` the source reads `\s*\(`, i.e. a BACKSLASH where the
  // pattern needs whitespace-then-paren) and does NOT match the test title. What it DOES
  // match is the non-vacuity fixture if that is written as ONE string literal — which is
  // what reddened this file on the first run. So the fixture stays split and joined at
  // runtime. The bracket class is kept as belt-and-braces, not as the mechanism.
  //
  // ⚠ THE PATTERN NOW MATCHES WHAT THE TITLE CLAIMS. The first version swept only
  // `async function admin(path` and therefore MISSED eight live private request helpers
  // in two other shapes — `async function adminReq(path` (`pickup-active-gate`,
  // `order-pickup-edit`, `payment-links`) and the arrow `const admin = (p, o = {}) =>
  // ctx[...]` (`invite-register-shell`, `ios-input-zoom`, `self-hosted-fonts`,
  // `product-desc-font`, `product-photo-lightbox`) — while asserting that no spec keeps
  // one "any more". A guard that names a general rule and checks one spelling is the
  // defect this row exists to prevent, one level up.
  //
  // ⚠ `const admin = () => ({ 'X-Admin-Token': … })` is NOT swept and is not an offender:
  // it is a HEADER FACTORY handed to a bare `ctx.*` call, not a request helper. Those
  // files belong to the separate „still inlines the header" gap recorded in the learnings.
  test('no spec file keeps an unadopted private admin REQUEST helper, in any of its three shapes', () => {
    const PRIVATE_COPY = new RegExp(
      ['async function [a]dmin\\w*\\s*\\(\\s*(path|p)\\b',
       'const [a]dmin\\w*\\s*=\\s*\\(\\s*(path|p)\\b[^)]*\\)\\s*=>\\s*ctx\\['].join('|'))

    // ⚠ DELIBERATELY NOT CONVERTED BY THIS ROW, each for a stated reason — the list is
    // the point: a NEW private copy still reds, and these stay visible instead of the
    // sweep quietly being narrowed around them. Converting them is a later row's work.
    const ALLOWED = new Set([
      'pickup-active-gate.spec.js', 'order-pickup-edit.spec.js', 'payment-links.spec.js',
      'invite-register-shell.spec.js', 'ios-input-zoom.spec.js', 'self-hosted-fonts.spec.js',
      'product-desc-font.spec.js', 'product-photo-lightbox.spec.js',
    ])

    const specs = readdirSync(HERE).filter((f) => f.endsWith('.spec.js'))
    const offenders = specs
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => PRIVATE_COPY.test(stripComments(readFileSync(join(HERE, f), 'utf8'))))

    // Non-vacuity, three halves: the sweep reads real files; the pattern recognises EACH
    // shape it claims to; and the allowlist is not a way to pass by listing everything.
    expect(specs.length, 'the sweep found spec files to read').toBeGreaterThan(50)
    expect(PRIVATE_COPY.test(['async function ', 'admin(path, opts = {}) {'].join('')),
      'shape 1: the named helper this row retired').toBe(true)
    expect(PRIVATE_COPY.test(['async function ', 'adminReq(path, opts = {}) {'].join('')),
      'shape 2: the same body under a different name').toBe(true)
    expect(PRIVATE_COPY.test(['const ', 'admin = (p, o = {}) => ctx[o.method]'].join('')),
      'shape 3: the arrow form').toBe(true)
    for (const f of ALLOWED) {
      expect(specs, `the allowlist names a spec that exists: ${f}`).toContain(f)
    }
    expect(offenders,
      'a private copy is a copy that stops getting fixed — adopt `makeAdmin()` from helpers/admin.js').toEqual([])
  })
})
