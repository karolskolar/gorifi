// GA-T1 — 10 §UC-GA-001 (Google columns on `friends` + `invitations`).
//
// Schema ONLY: no `/api/friends/auth/google`, no verifier, no frontend control
// exists yet (GA-T2 onward), which is why this file is `google-auth-schema.spec.js`
// and leaves the name `google-auth.spec.js` free for the full-flow spec that
// §UC-GA-013 obligation 5 asks for.
//
// The whole surface of this row is unreachable over HTTP by design — nothing
// reads or writes these columns yet, and `google_sub` must never appear in any
// response — so, exactly like `magic-link-schema.spec.js` (ML-T1), the tests boot
// `backend/src/db/schema.js` in a THROWAWAY subprocess against a temp DB file and
// read the migrated schema directly.
//
// Three kinds of test live here:
//
//  • fresh boot — the five columns and the partial UNIQUE index exist with the
//    declared types/defaults, and a SECOND boot on the same file is a no-op
//    (the idempotency half of the acceptance criteria).
//  • PRE-EXISTING DB — a database whose `friends`/`invitations` tables have been
//    stripped back to the pre-GA-T1 shape is booted again and must gain all five
//    columns + the index. ⚠ This is the criterion that actually matters
//    ("backend restart on an existing DB"): a fresh-DB-only test would still pass
//    if the columns were written into `CREATE TABLE` and the ALTER path were
//    broken.
//  • behaviour — two friends with the same non-NULL `google_sub` must throw
//    SQLITE_CONSTRAINT; two with NULL `google_sub` must coexist; `invitations`
//    carries both columns and NO unique index on `google_sub` (§UC-GA-001: the
//    authoritative uniqueness check is the friends index at approval, GA-T9).
//
// One extra assertion runs against the SHARED DB_PATH database — the database the
// running server migrated on restart — and self-skips without DB_PATH (the
// established 213/214 pattern).

import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB_PATH = process.env.DB_PATH || ''
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCHEMA_URL = 'file://' + join(REPO_ROOT, 'backend', 'src', 'db', 'schema.js')

const FRIEND_COLS = ['google_sub', 'google_email', 'google_prompt_dismissed']
const INVITATION_COLS = ['google_sub', 'google_email']
const INDEX_NAME = 'idx_friends_google_sub'

// ─── the throwaway-boot probe (the ML-T1 helper, verbatim in spirit) ─────────
// Runs a small ESM script in a child `node` with DB_PATH pointed at a temp file,
// so importing schema.js creates/migrates THAT database and never touches the
// suite's. Output is fished out by marker so any boot logging is ignored.
function probe(dbFile, body) {
  const dir = mkdtempSync(join(tmpdir(), 'ga-t1-probe-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    `import db from '${SCHEMA_URL}';\n` +
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

const SCHEMA_PROBE_BASE = `
  const indexesFor = (table) => db.all('PRAGMA index_list(' + JSON.stringify(table) + ')').map((i) => ({
    name: i.name,
    unique: i.unique,
    partial: i.partial,
    cols: db.all('PRAGMA index_info(' + JSON.stringify(i.name) + ')').map((c) => c.name),
    sql: (db.get("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?", [i.name]) || {}).sql || null,
  }));
  const shape = {
    friendsCols: db.all('PRAGMA table_info(friends)'),
    friendsIndexes: indexesFor('friends'),
    invitationsCols: db.all('PRAGMA table_info(invitations)'),
    invitationsIndexes: indexesFor('invitations'),
  };
`
const SCHEMA_PROBE = SCHEMA_PROBE_BASE + '\n  return shape;\n'

function colsByName(rows) {
  return Object.fromEntries(rows.map((c) => [c.name, c]))
}

// Strip the GA-T1 migration's output back out of an already-migrated database, so
// the next boot faces exactly the pre-GA-T1 shape a production DB has. The index
// goes first — SQLite refuses to DROP COLUMN a column an index depends on.
function stripGoogleColumns(dbFile) {
  const db = new DatabaseSync(dbFile)
  try {
    db.exec(`DROP INDEX IF EXISTS ${INDEX_NAME}`)
    for (const c of FRIEND_COLS) db.exec(`ALTER TABLE friends DROP COLUMN ${c}`)
    for (const c of INVITATION_COLS) db.exec(`ALTER TABLE invitations DROP COLUMN ${c}`)
  } finally {
    db.close()
  }
}

// Write a friend row into a database that does NOT yet have the Google columns,
// i.e. the population every production database is made of. Returns its id.
function seedPreMigrationFriend(dbFile, accessToken) {
  const db = new DatabaseSync(dbFile)
  try {
    db.exec("INSERT INTO order_cycles (name) VALUES ('GA-T1 pre-migration cycle')")
    const cyc = db.prepare('SELECT id FROM order_cycles ORDER BY id DESC LIMIT 1').get().id
    db.prepare('INSERT INTO friends (name, cycle_id, access_token) VALUES (?, ?, ?)').run(
      'Pre-migration friend',
      cyc,
      accessToken
    )
    return db.prepare('SELECT id FROM friends WHERE access_token = ?').get(accessToken).id
  } finally {
    db.close()
  }
}

function readShape(dbFile) {
  const db = new DatabaseSync(dbFile)
  try {
    return {
      friends: db.prepare('PRAGMA table_info(friends)').all().map((c) => c.name),
      invitations: db.prepare('PRAGMA table_info(invitations)').all().map((c) => c.name),
      indexes: db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='friends'")
        .all()
        .map((r) => r.name),
    }
  } finally {
    db.close()
  }
}

test.describe('UC-GA-001 Google schema', () => {
  test('a fresh boot adds the five columns and the partial UNIQUE index, and a SECOND boot on the same file is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ga-t1-db-'))
    const dbFile = join(dir, 'probe.sqlite')
    try {
      const first = probe(dbFile, SCHEMA_PROBE)

      // — friends columns —
      const f = colsByName(first.friendsCols)
      expect(f.google_sub, 'friends.google_sub exists').toBeTruthy()
      expect(f.google_sub.type, 'google_sub is TEXT').toBe('TEXT')
      expect(f.google_sub.notnull, 'google_sub is nullable — NULL means not linked').toBe(0)
      expect(f.google_sub.dflt_value, 'google_sub has no default').toBeFalsy()

      expect(f.google_email, 'friends.google_email exists').toBeTruthy()
      expect(f.google_email.type, 'google_email is TEXT').toBe('TEXT')
      expect(f.google_email.notnull, 'google_email is nullable').toBe(0)

      expect(f.google_prompt_dismissed, 'friends.google_prompt_dismissed exists').toBeTruthy()
      expect(f.google_prompt_dismissed.type, 'google_prompt_dismissed is INTEGER').toBe('INTEGER')
      expect(String(f.google_prompt_dismissed.dflt_value), 'defaults to 0').toBe('0')

      // — invitations columns —
      const i = colsByName(first.invitationsCols)
      expect(i.google_sub, 'invitations.google_sub exists').toBeTruthy()
      expect(i.google_sub.type, 'invitations.google_sub is TEXT').toBe('TEXT')
      expect(i.google_email, 'invitations.google_email exists').toBeTruthy()
      expect(i.google_email.type, 'invitations.google_email is TEXT').toBe('TEXT')

      // — the partial UNIQUE index (the idx_friends_username precedent) —
      const idx = first.friendsIndexes.find((x) => x.name === INDEX_NAME)
      expect(idx, `${INDEX_NAME} exists`).toBeTruthy()
      expect(idx.unique, 'the index is UNIQUE').toBe(1)
      expect(idx.cols, 'it covers google_sub alone').toEqual(['google_sub'])
      expect(idx.partial, 'it is PARTIAL — a bare ALTER cannot add UNIQUE').toBe(1)
      expect(idx.sql, 'the partial predicate is `google_sub IS NOT NULL`').toMatch(
        /WHERE\s+google_sub\s+IS\s+NOT\s+NULL/i
      )

      // — ⚠ invitations gets NO unique index on google_sub, by design
      //   (§UC-GA-001: authoritative uniqueness is the friends index at approval).
      const invUnique = first.invitationsIndexes.filter(
        (x) => x.unique === 1 && x.cols.includes('google_sub')
      )
      expect(invUnique, 'no unique index on invitations.google_sub').toEqual([])

      // — IDEMPOTENCY: boot #2 on the very same file must not throw, must not
      //   double up any ALTER-added column, and must not duplicate the index. If
      //   either guard (try/catch, IF NOT EXISTS) were missing, this call throws
      //   and the test reddens.
      const second = probe(dbFile, SCHEMA_PROBE)
      for (const name of FRIEND_COLS) {
        expect(
          second.friendsCols.filter((c) => c.name === name).length,
          `exactly one friends.${name} column after two boots`
        ).toBe(1)
      }
      for (const name of INVITATION_COLS) {
        expect(
          second.invitationsCols.filter((c) => c.name === name).length,
          `exactly one invitations.${name} column after two boots`
        ).toBe(1)
      }
      expect(
        second.friendsIndexes.filter((x) => x.name === INDEX_NAME).length,
        'exactly one idx_friends_google_sub'
      ).toBe(1)
      expect(
        second.friendsCols.map((c) => c.name),
        'friends column list unchanged by the second boot'
      ).toEqual(first.friendsCols.map((c) => c.name))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an EXISTING database that predates this row gains all five columns + the index on the next boot', () => {
    // ⚠ The real acceptance criterion. A fresh-DB test would pass even if the
    // columns lived in CREATE TABLE and the ALTER path were broken; and an index
    // statement buried inside an ALTER's try/catch would never run at all on a DB
    // where the ALTER throws "duplicate column" — i.e. on every already-migrated
    // production database. Only this shape catches either.
    const dir = mkdtempSync(join(tmpdir(), 'ga-t1-old-'))
    const dbFile = join(dir, 'existing.sqlite')
    try {
      probe(dbFile, 'return { booted: true };') // a fully migrated DB…
      stripGoogleColumns(dbFile) // …rolled back to the pre-GA-T1 shape

      const before = readShape(dbFile)
      // Non-vacuity: prove the strip really happened, or the re-boot below would
      // be asserting nothing.
      for (const c of FRIEND_COLS) expect(before.friends, `friends.${c} removed`).not.toContain(c)
      for (const c of INVITATION_COLS)
        expect(before.invitations, `invitations.${c} removed`).not.toContain(c)
      expect(before.indexes, 'index removed').not.toContain(INDEX_NAME)

      // ⚠ A friend that exists BEFORE the ALTER runs — which is every friend in
      // production. GA-T6's prompt gate evaluates
      // `!!friend.google_prompt_dismissed` over exactly this population, so what
      // the backfill puts in the column for a pre-existing row is load-bearing:
      // NULL would be falsy and read the same in that one expression, but it is
      // NOT what the column declares, and any later `= 0` / `IS NOT 1` predicate
      // would diverge. SQLite backfills a constant DEFAULT on ADD COLUMN; this
      // pins it rather than trusting it.
      const preId = seedPreMigrationFriend(dbFile, 'ga-pre-migration')
      expect(preId, 'the pre-migration friend row was really written').toBeGreaterThan(0)

      const after = probe(
        dbFile,
        SCHEMA_PROBE_BASE +
          `\n  shape.preExisting = db.get("SELECT id, google_prompt_dismissed AS dismissed, google_sub AS sub, google_email AS email FROM friends WHERE access_token = 'ga-pre-migration'");\n  return shape;\n`
      )
      expect(after.preExisting, 'the same row is still there after the migration').toBeTruthy()
      expect(after.preExisting.id, 'and it is the row seeded before the ALTER ran').toBe(preId)
      // Strictly 0 — `toBeFalsy()` would sail through on NULL, which is the very
      // thing this asserts against.
      expect(after.preExisting.dismissed, 'a pre-existing friend reads 0, not NULL').toBe(0)
      expect(after.preExisting.sub, 'the nullable columns backfill as NULL').toBe(null)
      expect(after.preExisting.email, 'the nullable columns backfill as NULL').toBe(null)

      const names = after.friendsCols.map((c) => c.name)
      for (const c of FRIEND_COLS) expect(names, `friends.${c} re-added by restart`).toContain(c)
      const invNames = after.invitationsCols.map((c) => c.name)
      for (const c of INVITATION_COLS)
        expect(invNames, `invitations.${c} re-added by restart`).toContain(c)

      const idx = after.friendsIndexes.find((x) => x.name === INDEX_NAME)
      expect(idx, 'the index is created on an existing DB too').toBeTruthy()
      expect(idx.unique, 'still UNIQUE').toBe(1)
      expect(idx.partial, 'still PARTIAL').toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a DB that already has the COLUMNS but lost the index gets the index back — the shared-try/catch trap', () => {
    // ⚠ The case the test above cannot see. If `CREATE UNIQUE INDEX` shared a
    // try/catch with `ALTER TABLE friends ADD COLUMN google_sub`, then on every
    // already-migrated database — i.e. the normal steady state, and every
    // production DB from the second restart onward — the ALTER throws "duplicate
    // column", the catch swallows it, and the CREATE INDEX never runs. The index
    // would then exist ONLY on databases created after this row landed, and the
    // "already linked" 409s of §UC-GA-004/008/009 would have no backstop.
    const dir = mkdtempSync(join(tmpdir(), 'ga-t1-noidx-'))
    const dbFile = join(dir, 'existing.sqlite')
    try {
      probe(dbFile, 'return { booted: true };')

      const db = new DatabaseSync(dbFile)
      try {
        db.exec(`DROP INDEX IF EXISTS ${INDEX_NAME}`)
      } finally {
        db.close()
      }
      // Non-vacuity: the columns are STILL there (so the ALTERs will throw on the
      // next boot), and only the index is missing.
      const before = readShape(dbFile)
      for (const c of FRIEND_COLS) expect(before.friends, `friends.${c} kept`).toContain(c)
      expect(before.indexes, 'index dropped').not.toContain(INDEX_NAME)

      const after = probe(dbFile, SCHEMA_PROBE)
      const idx = after.friendsIndexes.find((x) => x.name === INDEX_NAME)
      expect(idx, 'the index is (re)created even though every ALTER threw').toBeTruthy()
      expect(idx.unique, 'and it is UNIQUE').toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('two friends cannot share a non-NULL google_sub, but any number may have NULL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ga-t1-db-'))
    const dbFile = join(dir, 'probe.sqlite')
    try {
      const out = probe(
        dbFile,
        `
        // FKs off so the probe needs no order_cycles fixture beyond the one row it
        // inserts; friends.cycle_id and access_token are the legacy NOT NULL
        // columns a direct insert still has to satisfy.
        db.exec('PRAGMA foreign_keys = OFF');
        const res = {};
        db.run("INSERT INTO order_cycles (name) VALUES ('GA-T1 probe cycle')");
        const cyc = db.get('SELECT id FROM order_cycles ORDER BY id DESC LIMIT 1').id;

        db.run("INSERT INTO friends (name, cycle_id, access_token, google_sub, google_email) VALUES ('A', ?, 'ga-a', 'sub-shared', 'a@example.com')", [cyc]);
        try {
          db.run("INSERT INTO friends (name, cycle_id, access_token, google_sub) VALUES ('B', ?, 'ga-b', 'sub-shared')", [cyc]);
          res.duplicate = { outcome: 'accepted' };
        } catch (e) {
          res.duplicate = { outcome: 'rejected', code: e.code || null, message: e.message };
        }

        // NULL google_sub — unlinked friends, the overwhelming majority — must
        // coexist without limit.
        db.run("INSERT INTO friends (name, cycle_id, access_token) VALUES ('C', ?, 'ga-c')", [cyc]);
        db.run("INSERT INTO friends (name, cycle_id, access_token) VALUES ('D', ?, 'ga-d')", [cyc]);
        db.run("INSERT INTO friends (name, cycle_id, access_token, google_sub) VALUES ('E', ?, 'ga-e', NULL)", [cyc]);
        res.nulls = db.get('SELECT COUNT(*) AS n FROM friends WHERE google_sub IS NULL').n;

        // The default lands on rows that never mention the column.
        res.promptDefault = db.get("SELECT google_prompt_dismissed AS v FROM friends WHERE access_token = 'ga-c'").v;
        res.linkedEmail = db.get("SELECT google_email AS v FROM friends WHERE access_token = 'ga-a'").v;

        // invitations: two rows MAY share a sub — no unique index there by design.
        db.run("INSERT INTO invitations (invite_code, invited_by_friend_id, name, phone, google_sub, google_email) VALUES ('X1', 1, 'Inv A', '+421900000001', 'sub-shared', 'a@example.com')");
        try {
          db.run("INSERT INTO invitations (invite_code, invited_by_friend_id, name, phone, google_sub) VALUES ('X2', 1, 'Inv B', '+421900000002', 'sub-shared')");
          res.invitationDuplicate = 'accepted';
        } catch (e) {
          res.invitationDuplicate = 'rejected: ' + e.message;
        }
        return res;
      `
      )

      expect(out.duplicate.outcome, 'a second friend with the same google_sub is refused').toBe(
        'rejected'
      )
      expect(String(out.duplicate.code), 'the refusal is a SQLITE_CONSTRAINT').toMatch(
        /^SQLITE_CONSTRAINT/
      )
      expect(out.duplicate.message, 'and it names the unique index column').toMatch(
        /UNIQUE constraint failed: friends\.google_sub/
      )

      expect(out.nulls, 'three unlinked friends coexist with NULL google_sub').toBe(3)
      expect(Number(out.promptDefault), 'google_prompt_dismissed defaults to 0').toBe(0)
      expect(out.linkedEmail, 'google_email stores the display address').toBe('a@example.com')

      // ⚠ §UC-GA-001: NO unique index on invitations — two pending applicants may
      // carry the same sub in the DB; the courtesy checks (GA-T8) and the friends
      // index at approval (GA-T9) are what enforce uniqueness.
      expect(out.invitationDuplicate, 'invitations accept a duplicate google_sub').toBe('accepted')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the migration ran on the running server's database, not just in a throwaway probe", () => {
    test.skip(!DB_PATH, 'requires DB_PATH to inspect the database the running server migrated')
    const db = new DatabaseSync(DB_PATH)
    try {
      const friends = db.prepare('PRAGMA table_info(friends)').all()
      for (const c of FRIEND_COLS) {
        expect(
          friends.filter((x) => x.name === c).length,
          `friends.${c} added exactly once on the running server's DB`
        ).toBe(1)
      }
      const invitations = db.prepare('PRAGMA table_info(invitations)').all()
      for (const c of INVITATION_COLS) {
        expect(
          invitations.filter((x) => x.name === c).length,
          `invitations.${c} added exactly once on the running server's DB`
        ).toBe(1)
      }
      const idx = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
        .get(INDEX_NAME)
      expect(idx, `${INDEX_NAME} created on an existing DB by restart`).toBeTruthy()
      expect(idx.sql, 'and it is the partial UNIQUE form').toMatch(
        /CREATE UNIQUE INDEX[\s\S]*WHERE\s+google_sub\s+IS\s+NOT\s+NULL/i
      )
    } finally {
      db.close()
    }
  })
})
