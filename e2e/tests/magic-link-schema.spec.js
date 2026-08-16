// ML-T1 — 09 §UC-ML-001 (schema + token primitives) and §UC-ML-002 (the
// createFriendSession TTL split). Schema and primitives ONLY: no
// /api/magic-link/* endpoint exists yet (ML-T2 requests, ML-T3 redeems), which is
// why this file is `magic-link-schema.spec.js` and leaves the name
// `magic-link.spec.js` free for the full-flow spec UC-ML-010 obligation 1 asks for.
//
// Two kinds of test live here, and the split is deliberate:
//
//  • The TTL half is ordinary HTTP against the shared server — every mint site the
//    UC-ML-002 inventory names is reachable through a real endpoint, so nothing is
//    gated.
//  • The schema/primitive half cannot be reached over HTTP in this row at all (the
//    raw token never appears in any response by design, UC-ML-001), so it boots
//    `backend/src/db/schema.js` in a THROWAWAY subprocess against a temp DB file and
//    reads the primitives and the migrated schema directly. That subprocess is also
//    what makes the idempotency criterion a real test rather than a manual step: the
//    same probe runs twice against the same file, i.e. a second boot on a DB that
//    already carries the table and the column.
//  • One extra assertion runs against the SHARED DB_PATH database — a database that
//    was created before this change and migrated by the running server — because
//    that, and not a fresh file, is what "restart on an existing DB" means. It
//    self-skips without DB_PATH (the established 213/214 pattern).

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const DB_PATH = process.env.DB_PATH || ''
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCHEMA_URL = 'file://' + join(REPO_ROOT, 'backend', 'src', 'db', 'schema.js')
const AUTH_URL = 'file://' + join(REPO_ROOT, 'backend', 'src', 'middleware', 'friend-auth.js')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const DEFAULT_TTL = 24 * HOUR
const REMEMBER_TTL = 60 * DAY
// The acceptance criteria say "within a minute of"; a minute is also comfortably
// wider than any plausible clock skew between this process and the server.
const TOLERANCE = 60 * 1000

function expectTtl(expiresAt, expected, label) {
  expect(typeof expiresAt, `${label}: expiresAt is a number`).toBe('number')
  const ttl = expiresAt - Date.now()
  expect(
    Math.abs(ttl - expected),
    `${label}: TTL ${Math.round(ttl / 1000)}s should be within a minute of ${Math.round(expected / 1000)}s`
  ).toBeLessThan(TOLERANCE)
}

// ─── the throwaway-boot probe ────────────────────────────────────────────────
// Runs a small ESM script in a child `node` with DB_PATH pointed at a temp file,
// so importing schema.js creates/migrates THAT database and never touches the
// suite's. Output is fished out by marker so any boot logging is ignored.
function probe(dbFile, body) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-t1-probe-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    `import db, { generateLoginToken, hashLoginToken, LOGIN_TOKEN_TTL_MS } from '${SCHEMA_URL}';\n` +
      `const out = (() => {\n${body}\n})();\n` +
      `console.log('@@PROBE@@' + JSON.stringify(out));\n`
  )
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: { ...process.env, DB_PATH: dbFile },
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    const m = stdout.match(/@@PROBE@@(.*)/)
    if (!m) throw new Error(`probe produced no marker. stdout:\n${stdout}`)
    return JSON.parse(m[1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Same throwaway-boot idea, but importing `friend-auth.js` as well, so the probe
// can call `createFriendSession` DIRECTLY.
//
// ⚠ Why this exists (ML-T1 review, minor 2). The strict-boolean rule is enforced
// in TWO places — `req.body.remember === true` at the route and
// `opts.remember === true` in the primitive — and the route hands the primitive an
// already-strict boolean. So every HTTP-level test passes if EITHER layer is
// relaxed, and the primitive's own check, which is the one that will matter for
// ML-T3 and for any future caller that forwards a body value straight through, was
// unpinned. This probe calls the primitive with a raw truthy string, which no
// route can produce, and is the only thing in the suite that reddens when that
// check alone is loosened.
function probeAuth(dbFile, body) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-t1-auth-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    `import db from '${SCHEMA_URL}';\n` +
      `import { createFriendSession } from '${AUTH_URL}';\n` +
      `const out = (() => {\n${body}\n})();\n` +
      `console.log('@@PROBE@@' + JSON.stringify(out));\n`
  )
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: { ...process.env, DB_PATH: dbFile },
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    const m = stdout.match(/@@PROBE@@(.*)/)
    if (!m) throw new Error(`probe produced no marker. stdout:\n${stdout}`)
    return JSON.parse(m[1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SCHEMA_PROBE = `
  return {
    loginTokensSql: (db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='login_tokens'") || {}).sql || null,
    loginTokensCols: db.all('PRAGMA table_info(login_tokens)'),
    loginTokensFks: db.all('PRAGMA foreign_key_list(login_tokens)'),
    loginTokensIndexes: db.all('PRAGMA index_list(login_tokens)').map((i) => ({
      unique: i.unique,
      cols: db.all('PRAGMA index_info(' + JSON.stringify(i.name) + ')').map((c) => c.name),
    })),
    sessionsSql: (db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='friend_sessions'") || {}).sql || null,
    sessionsCols: db.all('PRAGMA table_info(friend_sessions)'),
  };
`

// ─────────────────────────────────────────────────────────────────────────────
// UC-ML-001 — schema
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UC-ML-001 schema', () => {
  test('a fresh boot creates login_tokens with the specified shape, and a SECOND boot on the same file is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-t1-db-'))
    const dbFile = join(dir, 'probe.sqlite')
    try {
      const first = probe(dbFile, SCHEMA_PROBE)

      // — the table itself —
      expect(first.loginTokensSql, 'login_tokens exists').toBeTruthy()
      expect(first.loginTokensSql, 'created with AUTOINCREMENT').toContain('AUTOINCREMENT')

      const cols = Object.fromEntries(first.loginTokensCols.map((c) => [c.name, c]))
      expect(Object.keys(cols).sort(), 'exactly the specified columns').toEqual(
        ['created_at', 'expires_at', 'friend_id', 'id', 'token_hash', 'used_at'].sort()
      )
      expect(cols.id.pk, 'id is the primary key').toBe(1)
      expect(cols.id.type).toBe('INTEGER')
      expect(cols.friend_id.type).toBe('INTEGER')
      expect(cols.friend_id.notnull, 'friend_id NOT NULL').toBe(1)
      expect(cols.token_hash.type).toBe('TEXT')
      expect(cols.token_hash.notnull, 'token_hash NOT NULL').toBe(1)
      // ms epoch integers, NOT the friend_sessions DATETIME/CURRENT_TIMESTAMP
      // shape — the cooldown math in UC-ML-003 compares in ms, and
      // second-resolution timestamps are the documented tiebreak trap.
      expect(cols.expires_at.type, 'expires_at is ms-epoch INTEGER').toBe('INTEGER')
      expect(cols.expires_at.notnull, 'expires_at NOT NULL').toBe(1)
      expect(cols.used_at.type, 'used_at is ms-epoch INTEGER').toBe('INTEGER')
      expect(cols.used_at.notnull, 'used_at is nullable — NULL means outstanding').toBe(0)
      expect(cols.created_at.type, 'created_at is ms-epoch INTEGER').toBe('INTEGER')
      expect(cols.created_at.notnull, 'created_at NOT NULL').toBe(1)
      expect(first.loginTokensSql, 'created_at is not a CURRENT_TIMESTAMP default').not.toContain(
        'CURRENT_TIMESTAMP'
      )

      // — UNIQUE(token_hash): lookups are by hash only, so it must be unique —
      const uniqueOnHash = first.loginTokensIndexes.some(
        (i) => i.unique === 1 && i.cols.length === 1 && i.cols[0] === 'token_hash'
      )
      expect(uniqueOnHash, 'token_hash carries a UNIQUE index').toBe(true)

      // — FK CASCADE: hard-deleting a friend takes their tokens (UC-ML-009 item 4) —
      const fk = first.loginTokensFks.find((f) => f.from === 'friend_id')
      expect(fk, 'friend_id has a foreign key').toBeTruthy()
      expect(fk.table).toBe('friends')
      expect(fk.to).toBe('id')
      expect(fk.on_delete, 'ON DELETE CASCADE').toBe('CASCADE')

      // — friend_sessions.via —
      const sess = Object.fromEntries(first.sessionsCols.map((c) => [c.name, c]))
      expect(sess.via, 'friend_sessions gained a via column').toBeTruthy()
      expect(sess.via.type, 'via is TEXT').toBe('TEXT')
      expect(sess.via.notnull, 'via is nullable — NULL is password/legacy').toBe(0)
      expect(sess.via.dflt_value, 'no default; absent means NULL').toBeFalsy()
      // ⚠ Value-agnostic on purpose: ML-T3 writes 'magic_link', module 10 may add
      // 'google'. A CHECK/enum here would make module 10 a schema migration.
      expect(first.sessionsSql, 'no CHECK constraint pins the via vocabulary').not.toContain('CHECK')

      // — IDEMPOTENCY: boot #2 on the very same file must not throw, and must not
      //   double up the ALTER-added column. If either guard (IF NOT EXISTS /
      //   try-catch) were missing, this call throws and the test reddens.
      const second = probe(dbFile, SCHEMA_PROBE)
      expect(second.sessionsCols.filter((c) => c.name === 'via').length, 'exactly one via column').toBe(1)
      expect(
        second.loginTokensCols.map((c) => c.name),
        'login_tokens unchanged by the second boot'
      ).toEqual(first.loginTokensCols.map((c) => c.name))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the migration ran on the PRE-EXISTING shared database, not just on a fresh file', () => {
    test.skip(!DB_PATH, 'requires DB_PATH to inspect the database the running server migrated')
    const db = new DatabaseSync(DB_PATH)
    try {
      const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='login_tokens'").get()
      expect(t, 'login_tokens created on an existing DB by restart').toBeTruthy()
      const via = db.prepare('PRAGMA table_info(friend_sessions)').all().filter((c) => c.name === 'via')
      expect(via.length, 'friend_sessions.via added exactly once').toBe(1)
    } finally {
      db.close()
    }
  })

  test('the schema accepts an outstanding token, refuses a duplicate hash, and keeps via value-agnostic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-t1-db-'))
    const dbFile = join(dir, 'probe.sqlite')
    try {
      const out = probe(
        dbFile,
        `
        // FKs off so the probe needs no friends/order_cycles fixture; the FK
        // DECLARATION is asserted from PRAGMA foreign_key_list above.
        db.exec('PRAGMA foreign_keys = OFF');
        const res = {};
        db.run("INSERT INTO login_tokens (friend_id, token_hash, expires_at, used_at, created_at) VALUES (1, 'h1', 2, NULL, 1)");
        res.outstanding = db.get("SELECT used_at FROM login_tokens WHERE token_hash = 'h1'");
        try {
          db.run("INSERT INTO login_tokens (friend_id, token_hash, expires_at, used_at, created_at) VALUES (1, 'h1', 2, NULL, 1)");
          res.duplicate = 'accepted';
        } catch (e) { res.duplicate = 'rejected'; }
        // module 10's future value must fit without a migration
        db.run("INSERT INTO friend_sessions (friend_id, token, expires_at, via) VALUES (1, 'probe-token', 2, 'google')");
        res.via = db.get("SELECT via FROM friend_sessions WHERE token = 'probe-token'").via;
        db.run("INSERT INTO friend_sessions (friend_id, token, expires_at) VALUES (1, 'probe-token-2', 2)");
        res.viaDefault = db.get("SELECT via FROM friend_sessions WHERE token = 'probe-token-2'").via;
        return res;
      `
      )
      expect(out.outstanding.used_at, 'NULL used_at = outstanding').toBe(null)
      expect(out.duplicate, 'UNIQUE(token_hash) rejects a second row with the same hash').toBe('rejected')
      expect(out.via, 'an unknown provenance value is stored verbatim').toBe('google')
      expect(out.viaDefault, 'omitting via yields NULL').toBe(null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UC-ML-001 — token primitives
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UC-ML-001 token primitives', () => {
  test('raw token is 64 lowercase hex, unpredictable, and hashed with SHA-256 at rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-t1-db-'))
    const dbFile = join(dir, 'probe.sqlite')
    try {
      const out = probe(
        dbFile,
        `
        const raws = [];
        for (let i = 0; i < 8; i++) raws.push(generateLoginToken());
        return { raws, hashes: raws.map((r) => hashLoginToken(r)), ttl: LOGIN_TOKEN_TTL_MS };
      `
      )

      for (const raw of out.raws) {
        expect(raw, `raw token ${raw} is 64 lowercase hex (randomBytes(32))`).toMatch(/^[a-f0-9]{64}$/)
      }
      expect(new Set(out.raws).size, 'every token is distinct').toBe(out.raws.length)

      for (let i = 0; i < out.raws.length; i++) {
        const raw = out.raws[i]
        const stored = out.hashes[i]
        // The stored form must not be the raw token — that is the whole point of
        // hashing at rest (a DB read must not yield a usable login link).
        expect(stored, 'the stored hash is not the raw token').not.toBe(raw)
        expect(stored, 'the hash is SHA-256 hex').toMatch(/^[a-f0-9]{64}$/)
        expect(stored, 'hash equals sha256(raw)').toBe(crypto.createHash('sha256').update(raw).digest('hex'))
      }

      // Deterministic — the redemption lookup in ML-T3 is `WHERE token_hash = ?`.
      expect(out.hashes[0]).toBe(crypto.createHash('sha256').update(out.raws[0]).digest('hex'))

      // 15 minutes, a fixed constant — the e2e manufactures expiry by writing the
      // row, never by shrinking a TTL env knob (UC-ML-001 / UC-ML-010 item 2).
      expect(out.ttl, 'TTL is exactly 15 minutes').toBe(15 * 60 * 1000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the TTL is not env-tunable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-t1-db-'))
    const dbFile = join(dir, 'probe.sqlite')
    try {
      // A stray env read would show up as a different constant here. Set every
      // plausible knob name; the constant must not move.
      const prev = { ...process.env }
      process.env.MAGIC_LINK_TTL_MS = '1'
      process.env.LOGIN_TOKEN_TTL_MS = '1'
      process.env.MAGIC_LINK_TTL_MINUTES = '1'
      try {
        const out = probe(dbFile, 'return { ttl: LOGIN_TOKEN_TTL_MS };')
        expect(out.ttl, 'TTL ignores the environment').toBe(15 * 60 * 1000)
      } finally {
        process.env = prev
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UC-ML-002 — the createFriendSession TTL split, across the mint-site inventory
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UC-ML-002 session TTL split', () => {
  let ctx
  let adminToken
  let uniq

  test.beforeEach(async () => {
    // Fixtures per test, never a shared beforeAll (the GSO-T8 worker-restart
    // lesson: Playwright restarts the worker after a failure and re-runs hooks).
    ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
    uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`
    adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token
  })

  test.afterEach(async () => {
    await ctx.dispose()
  })

  const admin = () => ({ 'X-Admin-Token': adminToken })

  async function makeBareFriend(tag) {
    const r = await ctx.post('/api/friends', { headers: admin(), data: { name: `ML1 ${tag} ${uniq}` } })
    expect(r.status(), 'create friend').toBeLessThan(300)
    return await r.json()
  }

  async function makeFriendWithLogin(tag, password = 'initPass1') {
    const friend = await makeBareFriend(tag)
    const username = `e2e_ml1_${tag}_${uniq}`.toLowerCase().slice(0, 30)
    await ctx.put(`/api/friends/${friend.id}/admin-username`, { headers: admin(), data: { username } })
    await ctx.put(`/api/friends/${friend.id}/reset-password`, { headers: admin(), data: { password } })
    return { ...friend, username, password }
  }

  async function authPersonal(friend, body = {}) {
    const res = await ctx.post('/api/friends/auth', {
      data: { username: friend.username, password: friend.password, ...body },
    })
    expect(res.status(), 'personal login').toBe(200)
    return await res.json()
  }

  async function authShared(friendId, body = {}) {
    const res = await ctx.post('/api/friends/auth', {
      data: { password: FRIENDS_PASSWORD, friendId, ...body },
    })
    expect(res.status(), 'legacy shared-password login').toBe(200)
    return await res.json()
  }

  test('remember: true buys 60 days on the personal branch', async () => {
    const friend = await makeFriendWithLogin('rem')
    const body = await authPersonal(friend, { remember: true })
    expectTtl(body.expiresAt, REMEMBER_TTL, 'remember: true')
  })

  test('remember absent is the new 24-hour default (the 30-day flat session is retired)', async () => {
    const friend = await makeFriendWithLogin('def')
    const body = await authPersonal(friend)
    expectTtl(body.expiresAt, DEFAULT_TTL, 'remember absent')
    // Non-vacuity for the whole file: 24 h and 60 d are far apart, and neither is
    // the retired 30 days.
    expect(body.expiresAt - Date.now(), 'nowhere near the retired 30-day horizon').toBeLessThan(2 * DAY)
  })

  test('remember: false is 24 hours', async () => {
    const friend = await makeFriendWithLogin('false')
    expectTtl((await authPersonal(friend, { remember: false })).expiresAt, DEFAULT_TTL, 'remember: false')
  })

  // ⚠ STRICT BOOLEAN. `remember` arrives from a JSON body an attacker (or a sloppy
  // client) controls; a truthy-check would hand 60 days to the string "false",
  // which is exactly what a mis-serialised checkbox sends.
  //
  // ⚠ The check is deliberately in BOTH layers — the route's
  // `{ remember: req.body.remember === true }` and `createFriendSession`'s own
  // `opts.remember === true`. Mutation-verified, and the two-layer bit matters:
  // relaxing EITHER one alone leaves these six green (the other still coerces),
  // so a reviewer must not read a passing suite as proof that one of them is
  // redundant. Relaxing both reddens all six.
  for (const value of ['false', 'true', 1, 'yes', {}, [1]]) {
    test(`remember: ${JSON.stringify(value)} (truthy but not === true) does NOT buy 60 days`, async () => {
      const friend = await makeFriendWithLogin(`s${JSON.stringify(value).replace(/\W/g, '')}`)
      const body = await authPersonal(friend, { remember: value })
      expectTtl(body.expiresAt, DEFAULT_TTL, `remember: ${JSON.stringify(value)}`)
    })
  }

  test('the legacy shared-password branch honours remember too', async () => {
    const friend = await makeBareFriend('legacy')
    expectTtl((await authShared(friend.id, { remember: true })).expiresAt, REMEMBER_TTL, 'shared + remember')
    expectTtl((await authShared(friend.id)).expiresAt, DEFAULT_TTL, 'shared, no remember')
  })

  test('change-password CARRIES OVER the presenting session\'s expiry, exactly', async () => {
    const friend = await makeFriendWithLogin('cp')
    const login = await authPersonal(friend, { remember: true })
    expectTtl(login.expiresAt, REMEMBER_TTL, 'remembered login')

    const res = await ctx.put(`/api/friends/${friend.id}/change-password`, {
      headers: { Authorization: `Bearer ${login.token}` },
      data: { currentPassword: friend.password, newPassword: 'newPass12345' },
    })
    expect(res.status(), 'change-password').toBe(200)
    const body = await res.json()
    // ±0: a remembered friend who changes their password keeps the horizon they
    // opted into — never re-derived (which would silently drop them to 24 h), never
    // extended. Exact equality is what distinguishes carry-over from re-derivation.
    expect(body.expiresAt, 'expiry carried over unchanged').toBe(login.expiresAt)
    expect(body.token, 're-minted with a new token').not.toBe(login.token)
  })

  test('change-password on a DEFAULT session also carries over, rather than re-deriving', async () => {
    const friend = await makeFriendWithLogin('cpd')
    const login = await authPersonal(friend)
    expectTtl(login.expiresAt, DEFAULT_TTL, 'default login')

    const res = await ctx.put(`/api/friends/${friend.id}/change-password`, {
      headers: { Authorization: `Bearer ${login.token}` },
      data: { currentPassword: friend.password, newPassword: 'newPass12345' },
    })
    expect(res.status()).toBe(200)
    expect((await res.json()).expiresAt, 'carried over to the millisecond').toBe(login.expiresAt)
  })

  test('setup-credentials carries over the presenting session\'s expiry', async () => {
    // A credential-less friend logs in through the legacy shared-password branch
    // (which mints a session), then sets their own login mid-session.
    const friend = await makeBareFriend('setup')
    const login = await authShared(friend.id, { remember: true })
    expectTtl(login.expiresAt, REMEMBER_TTL, 'remembered shared login')

    const username = `e2e_ml1_setup_${uniq}`.toLowerCase().slice(0, 30)
    const res = await ctx.post(`/api/friends/${friend.id}/setup-credentials`, {
      headers: { Authorization: `Bearer ${login.token}` },
      data: { username, password: 'setupPass123' },
    })
    expect(res.status(), 'setup-credentials').toBe(200)
    const body = await res.json()
    expect(body.expiresAt, 'expiry carried over unchanged').toBe(login.expiresAt)
    expect(body.token, 're-minted with a new token').not.toBe(login.token)
  })

  test('a session minted from a shared-password (no Bearer) setup-credentials falls back to the 24 h default', async () => {
    // No presenting SESSION row exists on this path — the caller authenticated with
    // the global X-Friends-Password header — so there is no expiry to carry over and
    // the default must apply rather than an undefined/NaN expiry.
    const friend = await makeBareFriend('setupshared')
    const username = `e2e_ml1_ss_${uniq}`.toLowerCase().slice(0, 30)
    const res = await ctx.post(`/api/friends/${friend.id}/setup-credentials`, {
      headers: { 'X-Friends-Password': FRIENDS_PASSWORD },
      data: { username, password: 'setupPass123' },
    })
    expect(res.status(), 'setup-credentials via shared password').toBe(200)
    expectTtl((await res.json()).expiresAt, DEFAULT_TTL, 'no presenting session')
  })

  test('the fifth mint site — onboarding auto-login — takes the 24 h default', async () => {
    // ⚠ NOT in the UC-ML-002 checklist, but it is a real createFriendSession caller
    // (onboarding.js). Decision: no opt-in is offered on the registration form, so
    // there is nothing to honour and 60 days must not be assumed on the friend's
    // behalf. It therefore takes the documented default like any other
    // non-remembering login.
    const created = await ctx.post('/api/onboarding-links', {
      headers: admin(),
      data: { note: `E2E ML1 onboarding ${uniq}` },
    })
    expect(created.status(), 'onboarding link create').toBe(201)
    const { token } = await created.json()

    const signup = await ctx.post(`/api/onboarding/${token}`, {
      data: {
        name: `ML1 Onboard ${uniq}`,
        phone: `+4219${uniq.replace(/\D/g, '').slice(0, 8).padEnd(8, '0')}`,
        username: `e2e_ml1_onb_${uniq}`.toLowerCase().slice(0, 30),
        password: 'onboardPass1',
      },
    })
    expect(signup.status(), 'onboarding signup').toBe(201)
    expectTtl((await signup.json()).expiresAt, DEFAULT_TTL, 'onboarding auto-login')
  })

  test('the response shape of every minting endpoint is unchanged', async () => {
    // UC-ML-002: only the TTL moves. The frontend's local expiry check keys on these
    // two fields and must keep working with zero changes.
    const friend = await makeFriendWithLogin('shape')
    const body = await authPersonal(friend, { remember: true })
    expect(Object.keys(body).sort()).toEqual(
      ['expiresAt', 'friend', 'hasCredentials', 'mustChangePassword', 'success', 'token'].sort()
    )
    // `remember` must not leak into the response, and nothing about the session's
    // provenance is published.
    expect(body.remember).toBeUndefined()
    expect(body.via).toBeUndefined()
  })

  // ⚠ FUP-T17 — re-scoped, and the ROW'S OWN PREMISE WAS WRONG. The backlog filed
  // this as "green only because nothing writes `via` yet". Nothing of the sort:
  // ML-T3 shipped `createFriendSession(friend.id, { via: 'magic_link' })` at
  // `magic-link.js:347`, which is the ONLY writer in the codebase. What actually
  // kept the old whole-table `WHERE via IS NOT NULL → 0` sweep green is a pair of
  // accidents, neither of them an invariant:
  //   1. every redemption in the suite runs against a THROWAWAY spawned backend with
  //      its own DB file (`withMailHarness` in magic-link.spec.js), so `via` is never
  //      written into the shared `DB_PATH` database this test opens; and
  //   2. file order — `magic-link-schema` sorts before `magic-link.spec` ('-' < '.'),
  //      so even a redemption against the shared server would land after this test.
  // Either accident is one task away from ending (ML-T6's UI flow, a spec that
  // redeems against the shared server, a `workers > 1` box reordering files), and the
  // sweep would then red for whoever ships it — pointing at ML-T1 code that is fine.
  //
  // The invariant worth keeping is narrower, and this test pins exactly it and no
  // more: NO ML-T1 MINT SITE WRITES A NON-NULL `via` — 'magic_link' is ML-T3's alone.
  // Each of the five sessions is minted BY THIS TEST and located by its own token, so
  // no other spec's magic-link session can perturb it.
  //
  // ⚠ What this test does NOT pin, stated so nobody reads more into it: the
  // CARRY-OVER case. `friends.js`'s change-password re-mint deliberately writes NULL
  // `via`, which is one of the two deaths of a magic-link session's waiver — but the
  // fixture below presents a session minted by a PASSWORD login, whose `via` is
  // already NULL, so a re-mint that started copying `via` forward is structurally
  // invisible here. That half is pinned where a magic-link session actually exists to
  // carry over: `magic-link.spec.js` §"the waiver DIES with the re-mint"
  // (§UC-ML-002 item 2). The two tests are complementary; neither subsumes the other.
  test('the five ML-T1 mint sites all leave via NULL (magic_link is ML-T3\'s alone)', async () => {
    test.skip(!DB_PATH, 'requires DB_PATH — no route lists sessions, so via is invisible over HTTP')

    // ── mint one session at each site, keeping the token that identifies its row ──
    const minted = []

    const personal = await makeFriendWithLogin('vperso')
    minted.push(['personal password login', (await authPersonal(personal, { remember: true })).token])

    const shared = await makeBareFriend('vshared')
    minted.push(['legacy shared-password login', (await authShared(shared.id)).token])

    const cp = await makeFriendWithLogin('vcp')
    const cpLogin = await authPersonal(cp)
    const cpRes = await ctx.put(`/api/friends/${cp.id}/change-password`, {
      headers: { Authorization: `Bearer ${cpLogin.token}` },
      data: { currentPassword: cp.password, newPassword: 'newPass12345' },
    })
    expect(cpRes.status(), 'change-password').toBe(200)
    minted.push(['change-password re-mint', (await cpRes.json()).token])

    const setup = await makeBareFriend('vsetup')
    const setupLogin = await authShared(setup.id)
    const setupRes = await ctx.post(`/api/friends/${setup.id}/setup-credentials`, {
      headers: { Authorization: `Bearer ${setupLogin.token}` },
      data: { username: `e2e_ml1_vsetup_${uniq}`.toLowerCase().slice(0, 30), password: 'setupPass123' },
    })
    expect(setupRes.status(), 'setup-credentials').toBe(200)
    minted.push(['setup-credentials re-mint', (await setupRes.json()).token])

    const link = await ctx.post('/api/onboarding-links', {
      headers: admin(),
      data: { note: `E2E FUPT17 via ${uniq}` },
    })
    expect(link.status(), 'onboarding link create').toBe(201)
    const signup = await ctx.post(`/api/onboarding/${(await link.json()).token}`, {
      data: {
        name: `ML1 Via Onboard ${uniq}`,
        phone: `+4218${uniq.replace(/\D/g, '').slice(0, 8).padEnd(8, '0')}`,
        username: `e2e_ml1_vonb_${uniq}`.toLowerCase().slice(0, 30),
        password: 'onboardPass1',
      },
    })
    expect(signup.status(), 'onboarding signup').toBe(201)
    minted.push(['onboarding auto-login', (await signup.json()).token])

    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      // Whole-table SHAPE sweep — legitimately global per FUP-T16's rule, and
      // deliberately NOT narrowed: the migrated column exists and every row's `via`
      // is either NULL or a string, whoever wrote it.
      for (const row of db.prepare('SELECT id, via FROM friend_sessions').all()) {
        expect(row.via === null || typeof row.via === 'string', `via shape on session ${row.id}`).toBe(true)
      }

      // VALUE claim — scoped to the five rows this test just created, found by token.
      expect(minted.length, 'all five ML-T1 mint sites were exercised').toBe(5)
      for (const [site, token] of minted) {
        expect(typeof token, `${site}: minted a Bearer`).toBe('string')
        const row = db.prepare('SELECT id, via FROM friend_sessions WHERE token = ?').get(token)
        expect(row, `${site}: its session row exists`).toBeTruthy()
        expect(row.via, `${site} must leave via NULL — 'magic_link' is ML-T3's alone`).toBeNull()
      }
    } finally {
      db.close()
    }
  })
})

// ⚠ ML-T1 review, minor 2 — the primitive's OWN strict-boolean check.
//
// Everything above reaches `createFriendSession` through a route, and the route
// already narrows `remember` to a real boolean (`req.body.remember === true`), so
// those tests pin the COMPOSITION of the two layers, not either one. Relaxing
// either check alone leaves all six of them green. These call the primitive
// directly with values no route can hand it.
test.describe('createFriendSession — the primitive enforces `remember === true` itself', () => {
  function ttlFor(remember) {
    const dir = mkdtempSync(join(tmpdir(), 'ml-t1-db-'))
    try {
      const out = probeAuth(join(dir, 'probe.sqlite'), `
        // ⚠ cycle_id and access_token are the legacy dead columns 09 §Accepted
        // risks keeps precisely BECAUSE they are NOT NULL and cannot be dropped
        // safely — and cycle_id additionally carries a live FK to order_cycles,
        // so "dead" here means unused by the app, not unconstrained. A direct
        // insert must satisfy all three.
        db.run("INSERT INTO order_cycles (name) VALUES ('Probe cycle')");
        const cyc = db.get('SELECT id FROM order_cycles ORDER BY id DESC LIMIT 1').id;
        db.run("INSERT INTO friends (name, cycle_id, access_token) VALUES ('Probe', ?, 'probe')", [cyc]);
        const id = db.get('SELECT id FROM friends ORDER BY id DESC LIMIT 1').id;
        const s = createFriendSession(id, ${remember});
        return { expiresAt: s.expiresAt, now: Date.now() };
      `)
      return out.expiresAt - out.now
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a truthy STRING must not buy the 60-day session', () => {
    // The exact failure the strict check exists for: a mis-serialised checkbox
    // sends the string "false", which is truthy.
    expect(Math.abs(ttlFor(`{ remember: 'false' }`) - DEFAULT_TTL)).toBeLessThan(TOLERANCE)
    expect(Math.abs(ttlFor(`{ remember: 'true' }`) - DEFAULT_TTL)).toBeLessThan(TOLERANCE)
    expect(Math.abs(ttlFor(`{ remember: 1 }`) - DEFAULT_TTL)).toBeLessThan(TOLERANCE)
  })

  test('and a real `true` still does — the check is strict, not broken', () => {
    // Non-vacuity: without this, the assertions above would also pass if the
    // primitive had simply lost its 60-day branch altogether.
    expect(Math.abs(ttlFor(`{ remember: true }`) - REMEMBER_TTL)).toBeLessThan(TOLERANCE)
  })

  test('a PAST expiresAt is refused rather than minting a dead session', () => {
    // ⚠ ML-T1 review, minor 1. The opportunistic cleanup inside
    // createFriendSession deletes rows with `expires_at < now`, so honouring a
    // past timestamp would delete the row it had just inserted and still hand the
    // caller a token that authenticates nowhere. Unreachable today
    // (`presentedSessionExpiry` filters on `expires_at > Date.now()`), so this
    // pins the guard, not a live bug.
    expect(Math.abs(ttlFor(`{ expiresAt: Date.now() - 60000 }`) - DEFAULT_TTL)).toBeLessThan(TOLERANCE)
  })
})
