// Module 19 — the guest WAITLIST write path (GL-T3). 19 §UC-GL-004 (the public signup
// `POST /api/guest/:token/waitlist`), §UC-GL-005 (the two purges), §UC-GL-009 (the
// admin ROUTES — the CycleDetail card is GL-T6), §UC-GL-010 (seams), and module 21's
// §UC-WA-002 contract for `helpers/phone.js toE164()`, which ships HERE and WA-T1
// adopts unchanged. 19 §UC-GL-011 item 4 is the obligation list this file answers.
//
// ⚠ WHY SO MUCH OF THIS IS A THROWAWAY-BOOT PROBE. The signup is accepted only in the
// PRE-OPEN state — no round open for the host, and (for a stale legacy link) none open
// elsewhere. The shared e2e target ALWAYS has open rounds (every spec's `makeCycle`),
// so over HTTP every valid token answers 409 `open` before the body is even read. The
// happy path, the idempotency key, the bounds and the consent rule therefore run
// against `routes/guest.js`'s pure `waitlistResponse()` in a child `node` on a temp DB
// (the GL-T2 `listingResponse()` idiom — same schema.js module instance, so the
// probe's `db` IS the router's). What only HTTP can prove — the refusals' status
// plumbing, the admin routes, the purge hooks in the REAL submit and the REAL complete
// PATCH, the host count — is pinned against the running server, each test on its own
// fixture, and every refusal READS THE ROWS BACK.
//
// NOTE ON RATE LIMITS: friend/admin auth sit on `authLimiter`; run with the raised
// budget (e2e/README.md). `rate-limit-isolation.spec.js` owns the guestWrite 429.

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'
import { stripComments } from '../helpers/source-pins.js'

const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src')
const HAS_BACKEND_SRC = existsSync(join(BACKEND_SRC, 'db', 'schema.js'))
const NEEDS_BACKEND_SRC = 'needs the backend source beside e2e/ (skipped against a deployment)'
const url = (rel) => 'file://' + join(BACKEND_SRC, rel)

// The uniform guest 404 (UC-GL-002 rule 1) and the new 409 (UC-GL-004 rule 1).
const GUEST_404 = 'Tento odkaz na objednávku neexistuje'
const OPEN_409 = { error: 'Objednávka je práve otvorená — môžeš si objednať rovno.', reason: 'open' }
const OK = { success: true }
// The admin list row, exactly (19 §UC-GL-009).
const ROW_KEYS = [
  'created_at', 'cycle_id', 'cycle_name', 'host_friend_id', 'host_name', 'id', 'name',
  'notified_at', 'phone', 'phone_e164', 'whatsapp_opt_in',
].sort()

// ═════════════════════════════════════════════════════════════════════════════
// The throwaway-boot probe (guest-standing-link.spec.js's, with the two new helpers
// imported too). A child `node` against a temp DB file; the suite's DB is never read.
// ═════════════════════════════════════════════════════════════════════════════
function probe(dbFile, body) {
  const dir = mkdtempSync(join(tmpdir(), 'gl-t3-probe-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    `import db from '${url('db/schema.js')}';\n` +
      `import * as sl from '${url('helpers/standing-link.js')}';\n` +
      `import * as wl from '${url('helpers/guest-waitlist.js')}';\n` +
      `import { toE164 } from '${url('helpers/phone.js')}';\n` +
      `import * as guest from '${url('routes/guest.js')}';\n` +
      `const out = (() => {\n${body}\n})();\n` +
      `console.log('@@PROBE@@' + JSON.stringify(out));\n`
  )
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: { ...process.env, DB_PATH: dbFile },
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const m = stdout.match(/@@PROBE@@(.*)/)
    if (!m) throw new Error(`probe produced no marker. stdout:\n${stdout}`)
    return JSON.parse(m[1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gl-t3-db-'))
  try {
    return fn(join(dir, 'gl-t3.sqlite'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A fresh DB with NO open round (pre-open for every standing token). `anchor` is the
// cycle the legacy `friends.cycle_id NOT NULL` needs; its status decides whether a
// „last closed round" exists (UC-GL-004 rule 3 → `lastClosedCycle()`).
const FIXTURE = (anchorStatus = 'completed') => `
  db.run("INSERT INTO order_cycles (name, status) VALUES ('anchor', '${anchorStatus}')");
  const anchor = db.get('SELECT id FROM order_cycles ORDER BY id DESC LIMIT 1').id;
  const mkF = (n, active = 1) => db.run(
    'INSERT INTO friends (name, cycle_id, access_token, active) VALUES (?, ?, ?, ?)', [n, anchor, 'acc-' + n, active]).lastInsertRowid;
  const cyc = (name, status) => db.run('INSERT INTO order_cycles (name, status) VALUES (?, ?)', [name, status]).lastInsertRowid;
  const rows = (hostId) => db.all('SELECT * FROM guest_waitlist WHERE host_friend_id = ? ORDER BY id', [hostId]);
  const all = () => db.all('SELECT * FROM guest_waitlist ORDER BY id');
  const W = (t, body) => guest.waitlistResponse(t, body);
`

// ═════════════════════════════════════════════════════════════════════════════
// §1 helpers/phone.js — 21 §UC-WA-002's contract, verbatim
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T3 · 21 §UC-WA-002 — helpers/phone.js toE164()', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('the three SK spellings converge; invalid ⇒ null; a Czech number stays Czech; it NEVER throws', () => {
    const out = withTempDb((file) => probe(file, `
      const cases = {
        national: toE164('0905 123 456'),
        plus: toE164('+421 905 123 456'),
        doubleZero: toE164('00421905123456'),
        compact: toE164('0905123456'),
        padded: toE164('   0905123456  '),
        number: toE164(905123456),
        czech: toE164('+420 601 234 567'),
        short: toE164('123'),
        letters: toE164('abc'),
        empty: toE164(''),
        blank: toE164('   '),
        zeros: toE164('0000000000'),
        nul: toE164(null),
        undef: toE164(undefined),
        object: toE164({}),
        array: toE164(['0905123456', 'x']),
        badToString: toE164({ toString: 1 }),
        nullOptions: toE164('0905123456', null),
        unknownCountry: toE164('0905123456', { defaultCountry: 'XX' }),
        czDefault: toE164('601 234 567', { defaultCountry: 'CZ' }),
      };
      return cases;
    `))
    for (const k of ['national', 'plus', 'doubleZero', 'compact', 'padded', 'number']) {
      expect(out[k], k).toBe('+421905123456')
    }
    expect(out.czech, '+420 is not rewritten to +421 (no hand-rolled prefix logic)').toBe('+420601234567')
    expect(out.czDefault, 'defaultCountry is honoured').toBe('+420601234567')
    for (const k of ['short', 'letters', 'empty', 'blank', 'zeros', 'nul', 'undef', 'object', 'badToString', 'unknownCountry']) {
      expect(out[k], `${k} ⇒ null`).toBe(null)
    }
    expect(out.nullOptions, 'a null options object is not a TypeError').toBe('+421905123456')
    // The contract's coercion is `String(raw ?? '')`, literally: an array stringifies
    // („0905123456,x") and the library reads the number out of it. Callers hand it an
    // already-validated STRING (asString() refuses arrays), so this is the contract
    // pinned as written, not a door.
    expect(out.array).toBe('+421905123456')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 The signup core — 19 §UC-GL-004, in the pre-open state the shared target lacks
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T3 · 19 §UC-GL-004 — waitlistResponse() (throwaway boot)', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('⚠ idempotency: „0905 123 456" then „+421 905 123 456" ⇒ two identical 200s and ONE row, the second name, the first phone; per HOST', () => {
    const out = withTempDb((file) => probe(file, FIXTURE() + `
      const a = mkF('Janka A'); const b = mkF('Peter B');
      const ta = sl.ensureStandingToken(a); const tb = sl.ensureStandingToken(b);
      const r = {};
      r.first = W(ta, { name: 'Eva Prvá', phone: '0905 123 456', whatsapp_opt_in: true });
      r.afterFirst = rows(a);
      r.second = W(ta, { name: 'Eva Druhá', phone: '+421 905 123 456' });
      r.afterSecond = rows(a);
      r.otherHost = W(tb, { name: 'Eva u Petra', phone: '00421905123456', whatsapp_opt_in: 1 });
      r.rowsA = rows(a); r.rowsB = rows(b);
      r.anchor = anchor;
      return r;
    `))
    expect(out.first).toEqual({ status: 200, body: OK })
    expect(out.second, 'a DUPLICATE answers byte-identically (no oracle, D3)').toEqual(out.first)
    expect(out.afterFirst).toHaveLength(1)
    const row = out.afterFirst[0]
    expect(row).toMatchObject({
      name: 'Eva Prvá', phone: '0905 123 456', phone_e164: '+421905123456', whatsapp_opt_in: 1,
      cycle_id: out.anchor, notified_at: null,
    })
    expect(out.afterSecond, 'ONE row for (host, e164)').toHaveLength(1)
    const again = out.afterSecond[0]
    expect(again.id, 'the same row, updated in place').toBe(row.id)
    expect(again.name, 'latest submission wins on the name').toBe('Eva Druhá')
    expect(again.whatsapp_opt_in, '…and on consent — omitted ⇒ 0').toBe(0)
    expect(again.phone, 'the phone AS FIRST ENTERED stays (rule 4 updates name/consent/cycle only)').toBe('0905 123 456')
    expect(again.created_at, 'created_at untouched').toBe(row.created_at)
    expect(out.rowsA, 'host B\'s signup is not host A\'s row').toHaveLength(1)
    expect(out.rowsB, 'the key is PER HOST — the same person under another host is another row').toHaveLength(1)
    expect(out.rowsB[0]).toMatchObject({ phone_e164: '+421905123456', whatsapp_opt_in: 1, name: 'Eva u Petra' })
  })

  test('a phone that does NOT normalise is kept with phone_e164 NULL, and is idempotent on the EXACT raw string', () => {
    const out = withTempDb((file) => probe(file, FIXTURE() + `
      const a = mkF('Janka A'); const t = sl.ensureStandingToken(a);
      const r = {};
      r.one = W(t, { name: 'Nula', phone: '0000 000 000' });
      r.two = W(t, { name: 'Nula znova', phone: '  0000 000 000 ' });
      r.afterSame = rows(a);
      r.three = W(t, { name: 'Nula inak', phone: '0000000000' });
      r.after = rows(a);
      return r;
    `))
    expect(out.one).toEqual({ status: 200, body: OK })
    expect(out.two).toEqual(out.one)
    expect(out.afterSame, 'normalisation never refuses a write; trimmed raw is the key').toHaveLength(1)
    expect(out.afterSame[0]).toMatchObject({ phone: '0000 000 000', phone_e164: null, name: 'Nula znova' })
    expect(out.three).toEqual(out.one)
    expect(out.after, 'a DIFFERENT raw spelling is a different key when nothing normalises (rule 4)').toHaveLength(2)
    expect(out.after.map((r) => r.phone)).toEqual(['0000 000 000', '0000000000'])
  })

  test('re-signup RE-ARMS a notified row (notified_at ⇒ NULL) and moves cycle_id to the current last round; created_at stays', () => {
    const out = withTempDb((file) => probe(file, FIXTURE() + `
      const a = mkF('Janka A'); const t = sl.ensureStandingToken(a);
      W(t, { name: 'Eva', phone: '0905 123 456', whatsapp_opt_in: true });
      db.run("UPDATE guest_waitlist SET notified_at = '2026-09-01 10:00:00'");
      const r = { before: rows(a)[0] };
      r.countNotified = sl.waitingCount(a);
      r.newer = cyc('newer locked', 'locked');
      r.again = W(t, { name: 'Eva', phone: '0905123456', whatsapp_opt_in: true });
      r.after = rows(a);
      r.countAfter = sl.waitingCount(a);
      return r;
    `))
    expect(out.before.notified_at, 'non-vacuity: the row really was notified').toBe('2026-09-01 10:00:00')
    expect(out.countNotified, 'a notified row does not count as waiting').toBe(0)
    expect(out.again).toEqual({ status: 200, body: OK })
    expect(out.after).toHaveLength(1)
    expect(out.after[0].notified_at, 're-armed for the next round').toBe(null)
    expect(out.after[0].cycle_id, 'cycle_id = lastClosedCycle() NOW (the newer locked round)').toBe(out.newer)
    expect(out.after[0].created_at).toBe(out.before.created_at)
    expect(out.countAfter, 'and it counts again (waiting_count)').toBe(1)
  })

  test('consent: absent/falsy ⇒ 0, any truthy ⇒ 1 (PO: never implied by omission); e-mail is not accepted', () => {
    const out = withTempDb((file) => probe(file, FIXTURE() + `
      const a = mkF('Janka A'); const t = sl.ensureStandingToken(a);
      const values = [['absent'], ['false', false], ['zero', 0], ['empty', ''], ['null', null],
                      ['true', true], ['one', 1], ['on', 'on'], ['string-false', 'false']];
      const r = {};
      values.forEach(([label, ...v], i) => {
        const body = { name: 'Súhlas ' + label, phone: '0905 000 ' + String(100 + i) };
        if (v.length) body.whatsapp_opt_in = v[0];
        r[label] = { res: W(t, body), stored: rows(a).find((x) => x.name === body.name).whatsapp_opt_in };
      });
      r.email = W(t, { name: 'S mailom', phone: '0905 000 200', email: { toString: 1 }, guest_email: 'x@y.z' });
      r.cols = db.all('PRAGMA table_info(guest_waitlist)').map((c) => c.name);
      return r;
    `))
    for (const k of ['absent', 'false', 'zero', 'empty', 'null']) {
      expect(out[k].res.status, k).toBe(200)
      expect(out[k].stored, `${k} ⇒ 0`).toBe(0)
    }
    for (const k of ['true', 'one', 'on', 'string-false']) expect(out[k].stored, `${k} ⇒ 1 (any truthy)`).toBe(1)
    expect(out.email, 'an e-mail — even an unbindable one — is IGNORED, not validated').toEqual({ status: 200, body: OK })
    expect(out.cols, 'and there is nowhere to store one').not.toContain('email')
  })

  test('⚠ refusals write NOTHING: bounds 120/32 (boundary accepted), too few digits, missing fields, the four unbindable shapes — read back', () => {
    const out = withTempDb((file) => probe(file, FIXTURE() + `
      const a = mkF('Janka A'); const t = sl.ensureStandingToken(a);
      const r = {};
      const cases = {
        name121: { name: 'x'.repeat(121), phone: '0905 111 222' },
        phone33: { name: 'Dlhý mobil', phone: '0905 111 222' + ' '.repeat(10) + '0'.repeat(11) },
        digits8: { name: 'Krátky', phone: '0905 111 2' },
        noName: { phone: '0905 111 222' },
        noPhone: { name: 'Bez mobilu' },
        nameObject: { name: { toString: 1 }, phone: '0905 111 222' },
        phoneArray: { name: 'Pole', phone: ['0905111222'] },
        emptyObject: {},
        bareTrue: true,
        oneElementArray: [1],
        bareString: 'abc',
      };
      for (const [k, body] of Object.entries(cases)) r[k] = W(t, body);
      r.lenPhone33 = cases.phone33.phone.length;
      r.afterRefusals = all().length;
      r.name120 = W(t, { name: 'y'.repeat(120), phone: '0905 111 223' });
      r.phone32 = W(t, { name: 'Mobil 32', phone: '+421 905 111 224' + ' '.repeat(16) });
      r.phone32Len = ('+421 905 111 224' + ' '.repeat(16)).length;
      r.p32 = '+421905111225'.padEnd(32, '1');
      r.phoneAt32 = W(t, { name: 'Presne 32', phone: r.p32 });
      r.after = all().length;
      return r;
    `))
    expect(out.lenPhone33, 'fixture: the phone really is 33 characters').toBe(33)
    const expected = {
      name121: { error: 'Meno je príliš dlhé (najviac 120 znakov)', field: 'name' },
      phone33: { error: 'Telefónne číslo je príliš dlhé (najviac 32 znakov)', field: 'phone' },
      digits8: { error: 'Zadaj telefónne číslo (aspoň 9 číslic)', field: 'phone' },
      noName: { error: 'Zadaj meno', field: 'name' },
      noPhone: { error: 'Zadaj telefónne číslo (aspoň 9 číslic)', field: 'phone' },
      nameObject: { error: 'Zadaj meno', field: 'name' },
      phoneArray: { error: 'Zadaj telefónne číslo (aspoň 9 číslic)', field: 'phone' },
      emptyObject: { error: 'Zadaj meno', field: 'name' },
      bareTrue: { error: 'Zadaj meno', field: 'name' },
      oneElementArray: { error: 'Zadaj meno', field: 'name' },
      bareString: { error: 'Zadaj meno', field: 'name' },
    }
    for (const [k, body] of Object.entries(expected)) {
      expect(out[k], k).toEqual({ status: 400, body })
    }
    expect(out.afterRefusals, 'NOT ONE refusal wrote a row').toBe(0)
    expect(out.name120, 'non-vacuity: 120 characters is accepted').toEqual({ status: 200, body: OK })
    expect(out.phone32Len).toBe(32)
    expect(out.phone32, 'a trimmed phone is measured AFTER the trim (asString)').toEqual({ status: 200, body: OK })
    expect(out.p32).toHaveLength(32)
    expect(out.phoneAt32, '32 characters exactly is accepted').toEqual({ status: 200, body: OK })
    expect(out.after, 'the three accepted signups are the only rows').toBe(3)
  })

  test('the state gates: standing + open round ⇒ 409 open; stale legacy link + a round open elsewhere ⇒ 409 open; stale with nothing open ⇒ accepted under the LINK\'s host; inactive ⇒ 410; unknown ⇒ the listing\'s 404 — nothing written by any refusal', () => {
    const out = withTempDb((file) => probe(file, FIXTURE() + `
      const a = mkF('Janka A'); const off = mkF('Vypnutý', 0);
      const ta = sl.ensureStandingToken(a);
      db.run("UPDATE friends SET guest_link_token = 'OFFHOSTOFFHOST' WHERE id = ?", [off]);
      const good = { name: 'Eva', phone: '0905 123 456', whatsapp_opt_in: true };
      const r = {};
      const old = cyc('old', 'locked');
      db.run("INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES ('LEGACYLEGACY22', ?, ?, 1)", [a, old]);
      r.staleNothingOpen = W('LEGACYLEGACY22', { name: 'Stará', phone: '0905 999 888' });
      r.rowsAfterStale = rows(a);
      const open = cyc('open now', 'open');
      r.standingOpen = W(ta, good);
      r.standingOpenBadBody = W(ta, {});
      r.staleOpenElsewhere = W('LEGACYLEGACY22', good);
      r.inactive = W('OFFHOSTOFFHOST', good);
      r.unknown = W('ZZZZZZZZZZZZZZ', good);
      r.listing404 = guest.listingResponse('ZZZZZZZZZZZZZZ');
      r.rowsAfter = all();
      r.old = old;
      return r;
    `))
    expect(out.staleNothingOpen, 'a stale link while NOTHING is open still collects (waitlist.available)').toEqual({ status: 200, body: OK })
    expect(out.rowsAfterStale).toHaveLength(1)
    expect(out.rowsAfterStale[0].cycle_id, 'keyed to the last closed round').toBe(out.old)
    expect(out.standingOpen, 'rule 1 — a round is open: order instead').toEqual({ status: 409, body: OPEN_409 })
    expect(out.standingOpenBadBody, 'the state gate comes FIRST (rule 1 before rule 2)').toEqual({ status: 409, body: OPEN_409 })
    expect(out.staleOpenElsewhere, 'rule 1 — preopen WITH openElsewhere is the same 409').toEqual({ status: 409, body: OPEN_409 })
    expect(out.inactive).toEqual({ status: 410, body: { error: 'Tento odkaz už nie je aktívny. Požiadaj kolegu o nový.', reason: 'inactive' } })
    expect(out.unknown.status).toBe(404)
    expect(out.unknown.body.error, 'the uniform 404 — the listing\'s own message').toBe(GUEST_404)
    expect(out.unknown.body, 'byte-identical to the listing\'s 404').toEqual(out.listing404.body)
    expect(out.rowsAfter, 'the refusals wrote nothing (the one row is the stale-link signup)').toHaveLength(1)
  })

  test('cycle_id = lastClosedCycle(): the newest locked/completed round, NULL when none has closed', () => {
    const out = withTempDb((file) => probe(file, FIXTURE('planned') + `
      const a = mkF('Janka A'); const t = sl.ensureStandingToken(a);
      const r = {};
      W(t, { name: 'Prvá', phone: '0905 100 001' });
      const c1 = cyc('c1', 'completed'); const c2 = cyc('c2', 'locked'); cyc('c3', 'planned');
      W(t, { name: 'Druhá', phone: '0905 100 002' });
      r.rows = rows(a).map((x) => x.cycle_id);
      r.c2 = c2;
      return r;
    `))
    expect(out.rows, 'no round had ever closed ⇒ NULL; then the newest locked/completed (a planned one never counts)').toEqual([null, out.c2])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §3 The constraint translation + the purge semantics, at helper level
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T3 · helpers/guest-waitlist.js (throwaway boot)', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('⚠ a lost race on idx_guest_waitlist_host_e164 is translated into the UPDATE path — never a 500; any OTHER constraint is re-thrown', () => {
    const out = withTempDb((file) => probe(file, FIXTURE() + `
      const a = mkF('Janka A');
      const realPrepare = db.prepare;
      let armed = true;
      db.prepare = (sql) => {
        if (armed && sql.includes('WHERE host_friend_id = ? AND phone_e164 = ?')) {
          armed = false;
          return { get: (h, e) => {
            realPrepare("INSERT INTO guest_waitlist (host_friend_id, name, phone, phone_e164, notified_at) VALUES (?, 'Víťaz', '0905123456', ?, '2026-09-01 10:00:00')").run(h, e);
            return undefined;
          } };
        }
        return realPrepare(sql);
      };
      const r = {};
      try { wl.joinWaitlist({ hostId: a, cycleId: anchor, name: 'Porazený', phone: '0905 123 456', optIn: 1 }); r.ok = true; }
      catch (e) { r.threw = String(e.message); }
      db.prepare = realPrepare;
      r.armedLeft = armed;
      r.rows = rows(a);
      try { wl.joinWaitlist({ hostId: 999999, cycleId: null, name: 'Nikto', phone: '0905 777 888', optIn: 0 }); r.fk = 'no throw'; }
      catch (e) { r.fk = String(e.code); }
      r.fkRows = all().length;
      return r;
    `))
    expect(out.armedLeft, 'non-vacuity: the forced miss really happened').toBe(false)
    expect(out.threw, 'no constraint error escapes').toBeUndefined()
    expect(out.rows, 'the winner\'s row is the only one').toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ name: 'Porazený', whatsapp_opt_in: 1, notified_at: null, phone: '0905123456' })
    expect(out.fk, 'a FOREIGN KEY failure is not „already signed up"').toBe('SQLITE_CONSTRAINT_FOREIGNKEY')
    expect(out.fkRows).toBe(1)
  })

  test('purgeWaitlistAfterTwoCompletions(): a row against round N survives N+1 and goes at N+2; a NULL row goes at the SECOND completion ever; locked rounds never count', () => {
    const out = withTempDb((file) => probe(file, FIXTURE('planned') + `
      const a = mkF('Janka A');
      const ins = (label, cycleId) => db.run('INSERT INTO guest_waitlist (host_friend_id, cycle_id, name, phone) VALUES (?, ?, ?, ?)', [a, cycleId, label, label]);
      const names = () => rows(a).map((x) => x.name).sort();
      const r = {};
      ins('null', null);
      const c1 = cyc('c1', 'completed'); r.p1 = wl.purgeWaitlistAfterTwoCompletions(); r.after1 = names();
      ins('n', c1);
      const c2 = cyc('c2', 'locked'); r.p2 = wl.purgeWaitlistAfterTwoCompletions(); r.afterLocked = names();
      db.run("UPDATE order_cycles SET status = 'completed' WHERE id = ?", [c2]);
      r.p3 = wl.purgeWaitlistAfterTwoCompletions(); r.after2 = names();
      cyc('c3', 'completed'); r.p4 = wl.purgeWaitlistAfterTwoCompletions(); r.after3 = names();
      return r;
    `))
    expect(out.after1, 'one completion ever: the NULL row stays').toEqual(['null'])
    expect(out.afterLocked, 'a LOCKED round is not a completion').toEqual(['n', 'null'])
    expect(out.p3, 'second completion: exactly the NULL row goes').toBe(1)
    expect(out.after2, '…the row against c1 has seen ONE completion after it (c2)').toEqual(['n'])
    expect(out.after3, 'c2 + c3 both completed after c1 ⇒ gone').toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// HTTP fixtures (per test, never a shared beforeAll fixture — the GSO-T8 lesson)
// ═════════════════════════════════════════════════════════════════════════════
let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const admin = makeAdmin({ ctx: () => ctx, token: () => adminToken, adopt: (t) => { adminToken = t } })

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => {
  await ctx?.dispose()
})

// A valid SK mobile unique to this run: `0905` + 6 digits. Its E.164 is `+421905…`.
let mobileSeq = 0
const mobileBase = Number(String(Date.now()).slice(-5)) * 10
function mobile() {
  const six = String((mobileBase + ++mobileSeq) % 1e6).padStart(6, '0')
  return { national: `0905${six}`, spaced: `+421 905 ${six.slice(0, 3)} ${six.slice(3)}`, e164: `+421905${six}` }
}

async function makeFriend(label) {
  const name = `GLW ${label} ${uniq}`
  const res = await admin('/api/friends', { method: 'post', data: { name, phone: '0905 000 111' } })
  expect(res.status(), 'friend create').toBe(201)
  return { ...(await res.json()), name }
}

// A host with a real Bearer session (for the host's own count — guest-standing-link's
// pattern). ⚠ A phone is set (the PI-T10 fixture fact), although no UI login happens.
let hostSeq = 0
async function makeHost(label) {
  const friend = await makeFriend(label)
  const suffix = `_${uniq}${++hostSeq}`
  const username = `glw_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const body = await login.json()
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || body.token
  return { ...friend, auth: { Authorization: `Bearer ${token}` } }
}

async function standingToken(friendId) {
  const res = await admin(`/api/friends/${friendId}/guest-link/standing`)
  expect(res.status(), 'admin standing GET (mints)').toBe(200)
  return (await res.json()).standing.token
}

async function makeCycle(label, status = 'open') {
  const name = `E2E GLW ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function setStatus(cycleId, status) {
  const res = await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status } })
  expect(res.status(), `PATCH status ${status}`).toBe(200)
}

async function addProduct(cycleId, label) {
  const res = await admin('/api/products', {
    method: 'post',
    data: { cycle_id: cycleId, name: `GLW Bean ${label} ${uniq}`, purpose: 'Espresso', price_250g: 8 },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function waitlistRows(hostId) {
  const res = await admin(`/api/guest-waitlist?host_friend_id=${hostId}`)
  expect(res.status(), 'admin waitlist GET').toBe(200)
  return (await res.json()).rows
}

// Direct writes: there is no public writer the shared target can reach (it always has
// an open round), so HTTP-level rows are planted in the server's own database.
function plant(hostId, { name, phone, e164 = null, cycleId = null, notified = null, optIn = 1 }) {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return Number(db.prepare(
      'INSERT INTO guest_waitlist (host_friend_id, cycle_id, name, phone, phone_e164, whatsapp_opt_in, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(hostId, cycleId, name, phone, e164, optIn, notified).lastInsertRowid)
  } finally {
    db.close()
  }
}

function dbRows(sql, ...params) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}
const rowsById = (...ids) => dbRows(`SELECT * FROM guest_waitlist WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids)

// ═════════════════════════════════════════════════════════════════════════════
// §4 The public POST over HTTP — the refusals the shared target CAN reach
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T3 · POST /api/guest/:token/waitlist — refusals over HTTP, read back', () => {
  test('unknown token ⇒ 404 whose body EQUALS the listing\'s 404 (no oracle); nothing written', async () => {
    const post = await ctx.post('/api/guest/ZZZZZZZZZZZZZZ/waitlist', { data: { name: 'Nikto', phone: '0905 123 456' } })
    const listing = await ctx.get('/api/guest/ZZZZZZZZZZZZZZ')
    expect(post.status()).toBe(404)
    expect(listing.status()).toBe(404)
    const body = await post.json()
    expect(body).toEqual({ error: GUEST_404 })
    expect(body, 'byte-identical to the listing').toEqual(await listing.json())
  })

  test('a round open for the host ⇒ 409 `open` — standing token, per-cycle token, and a stale link with the round open elsewhere; no row, valid body or not', async () => {
    const host = await makeFriend('Open')
    const tok = await standingToken(host.id)
    const old = await makeCycle('Open old')
    const legacyRes = await admin(`/api/guest-links/cycle/${old.id}/host/${host.id}`, { method: 'post' })
    expect(legacyRes.status(), 'admin per-cycle create').toBe(201)
    const legacy = (await legacyRes.json()).link.token
    const m = mobile()
    const good = { name: 'Eva', phone: m.national, whatsapp_opt_in: true }

    const perCycleOpen = await ctx.post(`/api/guest/${legacy}/waitlist`, { data: good })
    expect(perCycleOpen.status(), 'per-cycle token on an OPEN round').toBe(409)
    expect(await perCycleOpen.json()).toEqual(OPEN_409)

    await setStatus(old.id, 'locked')
    const newer = await makeCycle('Open newer')
    for (const [label, t, data] of [
      ['standing, valid body', tok, good],
      ['standing, EMPTY body (the gate is checked first)', tok, {}],
      ['stale legacy, open elsewhere', legacy, good],
    ]) {
      const res = await ctx.post(`/api/guest/${t}/waitlist`, { data })
      expect(res.status(), label).toBe(409)
      expect(await res.json(), label).toEqual(OPEN_409)
    }
    expect(await waitlistRows(host.id), 'NOT ONE refusal wrote a row').toEqual([])
    // Non-vacuity: the listing agrees the state really is „open" for the standing token
    // (the live listing), and „open elsewhere" for the stale one.
    expect((await (await ctx.get(`/api/guest/${tok}`)).json()).cycle.id).toBe(newer.id)
    expect((await (await ctx.get(`/api/guest/${legacy}`)).json()).waitlist).toEqual({ available: false })
  })

  test('an INACTIVE host ⇒ 410 inactive; nothing written — read back', async () => {
    const host = await makeFriend('Off')
    const tok = await standingToken(host.id)
    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)
    const res = await ctx.post(`/api/guest/${tok}/waitlist`, { data: { name: 'Eva', phone: mobile().national } })
    expect(res.status()).toBe(410)
    expect((await res.json()).reason).toBe('inactive')
    expect(await waitlistRows(host.id)).toEqual([])
  })

  test('unbindable bodies never 500: `true` / `\'abc\'` are the parser\'s 400; `{}` / `[1]` reach the resolver', async () => {
    const host = await makeFriend('Shape')
    const tok = await standingToken(host.id)
    for (const [label, data] of [['true', 'true'], ['abc', '"abc"'], ['{}', '{}'], ['[1]', '[1]']]) {
      for (const t of [tok, 'ZZZZZZZZZZZZZZ']) {
        const res = await ctx.post(`/api/guest/${t}/waitlist`, { data, headers: { 'Content-Type': 'application/json' } })
        expect(res.status(), `${label} on ${t === tok ? 'a live' : 'an unknown'} token`).toBeLessThan(500)
        expect([400, 404, 409], label).toContain(res.status())
      }
    }
    expect(await waitlistRows(host.id)).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §5 The admin routes (19 §UC-GL-009) + the host's count
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T3 · admin GET/DELETE /api/guest-waitlist + waiting_count', () => {
  test.skip(!DB_PATH, NEEDS_DB)

  test('GET lists rows IN FULL with host_name + cycle_name, exact keys, ordered host NOCASE → created_at DESC → id DESC; ?host_friend_id filters, a non-integer is ignored', async () => {
    const zed = await makeFriend('zeta')
    const alpha = await makeFriend('Alfa')
    const cycle = await makeCycle('List', 'completed')
    const m1 = mobile(); const m2 = mobile(); const m3 = mobile()
    const z1 = plant(zed.id, { name: 'Zed jeden', phone: m1.national, e164: m1.e164, cycleId: cycle.id })
    const z2 = plant(zed.id, { name: 'Zed dva', phone: m2.national, e164: m2.e164 })
    const a1 = plant(alpha.id, { name: 'Alfa jeden', phone: m3.national, e164: m3.e164, optIn: 0, notified: '2026-09-01 10:00:00' })

    const res = await admin('/api/guest-waitlist')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['rows'])
    const mine = body.rows.filter((r) => [z1, z2, a1].includes(r.id))
    expect(mine.map((r) => r.id), '„GLW Alfa" before „GLW zeta" (NOCASE); same created_at second ⇒ id DESC').toEqual([a1, z2, z1])
    for (const r of mine) expect(Object.keys(r).sort()).toEqual(ROW_KEYS)
    expect(mine[2]).toMatchObject({
      host_friend_id: zed.id, host_name: zed.name, name: 'Zed jeden', phone: m1.national,
      phone_e164: m1.e164, whatsapp_opt_in: 1, cycle_id: cycle.id, cycle_name: cycle.name, notified_at: null,
    })
    expect(mine[1].cycle_name, 'LEFT JOIN: no cycle ⇒ null').toBe(null)
    expect(mine[0]).toMatchObject({ whatsapp_opt_in: 0, notified_at: '2026-09-01 10:00:00' })

    const filtered = await waitlistRows(zed.id)
    expect(filtered.map((r) => r.id)).toEqual([z2, z1])
    for (const junk of ['abc', '1.5', '-1', '0', `${zed.id}abc`]) {
      const r = await admin(`/api/guest-waitlist?host_friend_id=${encodeURIComponent(junk)}`)
      expect(r.status(), junk).toBe(200)
      const ids = (await r.json()).rows.map((x) => x.id)
      expect(ids, `${junk}: ignored ⇒ the unfiltered list`).toEqual(expect.arrayContaining([z1, z2, a1]))
    }
    const repeated = await admin(`/api/guest-waitlist?host_friend_id=${zed.id}&host_friend_id=${alpha.id}`)
    expect((await repeated.json()).rows.map((x) => x.id), 'a repeated key (an array) is ignored').toEqual(expect.arrayContaining([z1, a1]))
  })

  test('DELETE removes the row (200), a second DELETE and a junk id 404; the host\'s waiting_count follows — and the host payload carries no name or phone', async () => {
    const host = await makeHost('Count')
    const base = await ctx.get('/api/guest-links/standing', { headers: host.auth })
    expect(base.status()).toBe(200)
    expect((await base.json()).waiting_count, 'a fresh host waits for nobody').toBe(0)

    const m1 = mobile(); const m2 = mobile(); const m3 = mobile()
    const w1 = plant(host.id, { name: 'Čaká Jedna', phone: m1.national, e164: m1.e164 })
    const w2 = plant(host.id, { name: 'Čaká Dva', phone: m2.national, e164: m2.e164 })
    plant(host.id, { name: 'Už upozornená', phone: m3.national, e164: m3.e164, notified: '2026-09-01 10:00:00' })

    const counted = await (await ctx.get('/api/guest-links/standing', { headers: host.auth })).json()
    expect(counted.waiting_count, 'two waiting; the notified row does not count').toBe(2)
    expect(Object.keys(counted).sort(), 'the host payload keys, exactly').toEqual(['current', 'standing', 'waiting_count'])
    const text = JSON.stringify(counted)
    for (const leak of ['Čaká Jedna', 'Čaká Dva', m1.national, m1.e164, '"phone"', '"phone_e164"']) {
      expect(text, `the host never sees ${leak}`).not.toContain(leak)
    }

    const del = await admin(`/api/guest-waitlist/${w1}`, { method: 'delete' })
    expect(del.status()).toBe(200)
    expect(await del.json()).toEqual(OK)
    expect(rowsById(w1, w2).map((r) => r.id), 'the row is gone from the DB, its sibling is not').toEqual([w2])
    expect((await (await ctx.get('/api/guest-links/standing', { headers: host.auth })).json()).waiting_count, 'count drops by one').toBe(1)

    const again = await admin(`/api/guest-waitlist/${w1}`, { method: 'delete' })
    expect(again.status()).toBe(404)
    expect(await again.json()).toEqual({ error: 'Záznam nebol nájdený' })
    for (const junk of ['abc', '0', '-1', `${w2}x`, '1.5']) {
      expect((await admin(`/api/guest-waitlist/${encodeURIComponent(junk)}`, { method: 'delete' })).status(), junk).toBe(404)
    }
    expect(rowsById(w2), `${w2}x must not have been parsed as ${w2}`).toHaveLength(1)
  })

  test('anonymous and a friend Bearer ⇒ 401 on both routes; the refused DELETE removed nothing — read back', async () => {
    const host = await makeHost('Auth')
    const m = mobile()
    const id = plant(host.id, { name: 'Chránená', phone: m.national, e164: m.e164 })
    for (const headers of [{}, host.auth]) {
      expect((await ctx.get('/api/guest-waitlist', { headers })).status()).toBe(401)
      expect((await ctx.delete(`/api/guest-waitlist/${id}`, { headers })).status()).toBe(401)
    }
    expect(rowsById(id), 'still there').toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §6 The purges over HTTP — the REAL submit and the REAL complete PATCH (UC-GL-005)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T3 · 19 §UC-GL-005 — the purges', () => {
  test.skip(!DB_PATH, NEEDS_DB)

  test('⚠ on ORDER: phone P signed up under hosts A and B; the guest orders through A\'s STANDING link with P spelled differently ⇒ BOTH rows gone (D5), an unrelated row stays, the sub-order exists', async () => {
    const a = await makeFriend('PurgeA')
    const b = await makeFriend('PurgeB')
    const tok = await standingToken(a.id)
    const cycle = await makeCycle('PurgeOrder')
    const product = await addProduct(cycle.id, 'PurgeOrder')
    const p = mobile(); const q = mobile()
    const pa = plant(a.id, { name: 'P u A', phone: p.national, e164: p.e164 })
    const pb = plant(b.id, { name: 'P u B', phone: p.national, e164: p.e164 })
    const qa = plant(a.id, { name: 'Q u A', phone: q.national, e164: q.e164 })

    // Counter-pin first: a REFUSED submit (empty cart ⇒ 400) purges nothing.
    const refused = await ctx.post(`/api/guest/${tok}/orders`, { data: { guest_name: 'P', guest_phone: p.spaced, items: [] } })
    expect(refused.status()).toBe(400)
    expect(rowsById(pa, pb, qa), 'a refused submit purges nothing').toHaveLength(3)

    const res = await ctx.post(`/api/guest/${tok}/orders`, {
      data: { guest_name: 'P objednáva', guest_phone: p.spaced, items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
    })
    expect(res.status(), 'the submit').toBe(201)
    const order = (await res.json()).order
    expect(order.guest_phone, 'non-vacuity: the phone was spelled differently from the rows').toBe(p.spaced)
    expect(rowsById(pa, pb, qa).map((r) => r.id), 'P is gone under BOTH hosts; Q stays').toEqual([qa])
    expect(dbRows('SELECT id FROM guest_orders WHERE id = ?', order.id), 'the sub-order exists').toHaveLength(1)
  })

  test('on ORDER with a phone that does NOT normalise: only THIS host\'s row with the exact raw phone goes', async () => {
    const a = await makeFriend('RawA')
    const b = await makeFriend('RawB')
    const tok = await standingToken(a.id)
    const cycle = await makeCycle('PurgeRaw')
    const product = await addProduct(cycle.id, 'PurgeRaw')
    const raw = `0000 ${String(mobileBase + ++mobileSeq).padStart(6, '0').slice(-6)}`
    const ra = plant(a.id, { name: 'Raw u A', phone: raw })
    const rb = plant(b.id, { name: 'Raw u B', phone: raw })
    const res = await ctx.post(`/api/guest/${tok}/orders`, {
      data: { guest_name: 'Raw objednáva', guest_phone: raw, items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
    })
    expect(res.status()).toBe(201)
    expect(rowsById(ra, rb).map((r) => r.id), 'host B\'s row survives — the raw key is per host').toEqual([rb])
  })

  test('after TWO completions, on the admin complete PATCH: a row against round N survives N+1 and goes at N+2; locking is not completing', async () => {
    const host = await makeFriend('Rounds')
    const n = await makeCycle('Round N')
    await setStatus(n.id, 'completed')
    const m = mobile()
    const row = plant(host.id, { name: 'Čaká od N', phone: m.national, e164: m.e164, cycleId: n.id })

    const n1 = await makeCycle('Round N+1')
    await setStatus(n1.id, 'completed')
    expect(rowsById(row), 'one completion after N: it stays').toHaveLength(1)

    const n2 = await makeCycle('Round N+2')
    await setStatus(n2.id, 'locked')
    expect(rowsById(row), 'a LOCK is not a completion (and does not run the purge)').toHaveLength(1)
    await setStatus(n2.id, 'completed')
    expect(rowsById(row), 'N+1 and N+2 both completed ⇒ purged').toHaveLength(0)
  })

  test('the purge runs on the TRANSITION only: re-saving a completed round or editing its name purges nothing; the next transition does', async () => {
    const host = await makeFriend('Resave')
    const done = await makeCycle('Resave done')
    await setStatus(done.id, 'completed')
    const m = mobile()
    // cycle_id NULL counts from 0 — on the shared target it already qualifies.
    const row = plant(host.id, { name: 'Čaká bez kola', phone: m.national, e164: m.e164 })
    await setStatus(done.id, 'completed')
    expect((await admin(`/api/cycles/${done.id}`, { method: 'patch', data: { name: `${done.name} x` } })).status()).toBe(200)
    expect(rowsById(row), 'completed → completed and a name edit are not transitions').toHaveLength(1)
    const next = await makeCycle('Resave next')
    await setStatus(next.id, 'completed')
    expect(rowsById(row), 'a NULL row that has seen ≥ 2 completions goes at the next transition').toHaveLength(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §7 Source pins (comments stripped, readability-gated)
// ═════════════════════════════════════════════════════════════════════════════
function readable(abs, mustContain) {
  const raw = readFileSync(abs, 'utf8')
  const src = stripComments(raw)
  expect(src.length / raw.length, `${abs}: the comment strip returned almost nothing`).toBeGreaterThan(0.05)
  for (const token of mustContain) expect(src, `${abs}: \`${token}\` must survive the strip`).toContain(token)
  return src
}
const backend = (rel, mustContain) => readable(join(BACKEND_SRC, rel), mustContain)
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.js')) out.push(p)
  }
  return out
}
// The body of the ONE `db.transaction(() => { … })` that starts after `anchor`.
function transactionAfter(src, anchor) {
  const start = src.indexOf(anchor)
  expect(start, `anchor ${anchor}`).toBeGreaterThan(-1)
  const tx = src.indexOf('db.transaction(', start)
  expect(tx, 'a transaction follows the anchor').toBeGreaterThan(-1)
  const end = src.indexOf('})', tx)
  return src.slice(tx, end)
}

test.describe('GL-T3 · source pins', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('ONE normaliser: `parsePhoneNumber` appears in helpers/phone.js and nowhere else in backend/src', () => {
    const hits = walk(BACKEND_SRC).filter((f) => /parsePhoneNumber/.test(readFileSync(f, 'utf8')))
    expect(hits.map((f) => f.slice(BACKEND_SRC.length + 1))).toEqual(['helpers/phone.js'])
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'backend', 'package.json'), 'utf8'))
    expect(pkg.dependencies, 'libphonenumber-js is a declared dependency').toHaveProperty('libphonenumber-js')
  })

  test('ONE writer home: every INSERT/UPDATE/DELETE on guest_waitlist lives in helpers/guest-waitlist.js; notified_at is only ever RESET to NULL there', () => {
    const writers = []
    for (const f of walk(BACKEND_SRC)) {
      const src = stripComments(readFileSync(f, 'utf8'))
      if (/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+guest_waitlist\b/.test(src)) writers.push(f.slice(BACKEND_SRC.length + 1))
      if (!f.endsWith('helpers/guest-waitlist.js')) {
        expect(src, `${f}: no notified_at write outside the helper`).not.toMatch(/notified_at\s*=\s*(?!NULL\b)[^=]/)
      }
    }
    expect(writers).toEqual(['helpers/guest-waitlist.js'])
    const helper = backend('helpers/guest-waitlist.js', ['export function joinWaitlist', 'notified_at = NULL'])
    const assigns = helper.match(/notified_at\s*=\s*[^\s,]+/g)
    expect(assigns, 'the helper assigns notified_at exactly once, to NULL (module 21 owns every other write)').toEqual(['notified_at = NULL'])
  })

  test('the purges sit INSIDE their transactions: the guest submit\'s and the complete PATCH\'s', () => {
    const guest = backend('routes/guest.js', ["router.post('/:token/orders'", 'purgeWaitlistOnOrder('])
    expect(transactionAfter(guest, "router.post('/:token/orders'"), 'the submit tx').toContain('purgeWaitlistOnOrder(guestPhone, link.host_friend_id)')
    const cycles = backend('routes/cycles.js', ["router.patch('/:id'", 'purgeWaitlistAfterTwoCompletions('])
    const patch = cycles.slice(cycles.indexOf("router.patch('/:id'"), cycles.indexOf("router.delete('/:id'"))
    expect(transactionAfter(patch, 'const completing'), 'the PATCH tx').toContain('if (completing) purgeWaitlistAfterTwoCompletions()')
    expect(patch).toMatch(/const completing = status === 'completed' && cycle\.status !== 'completed'/)
  })

  test('the public POST: guestWrite bucket, synchronous, no new limiter; the admin router is a requireAdmin MOUNT; the ADMIN_ENDPOINTS sweep has both admin routes and never the public one', () => {
    const guest = backend('routes/guest.js', ["router.post('/:token/waitlist'"])
    expect(guest).toMatch(/router\.post\('\/:token\/waitlist', guestWriteLimiter, \(req, res\) =>/)
    for (const rel of ['routes/guest.js', 'routes/guest-waitlist.js', 'helpers/guest-waitlist.js', 'helpers/phone.js']) {
      const src = backend(rel, [])
      expect(src.match(/\basync\b|\bawait\b/g), `${rel}: zero concurrency keywords (GA-T8)`).toBe(null)
    }
    const limiter = backend('middleware/rate-limit.js', ['export const guestWriteLimiter'])
    expect(limiter.match(/export const \w+Limiter/g), 'still FIVE buckets').toHaveLength(5)
    const index = backend('index.js', ["app.use('/api/guest-waitlist'"])
    expect(index).toMatch(/app\.use\('\/api\/guest-waitlist', requireAdmin, guestWaitlistRouter\)/)

    const sec = readable(join(REPO_ROOT, 'e2e', 'tests', 'api-security.spec.js'), ['const ADMIN_ENDPOINTS'])
    const list = sec.slice(sec.indexOf('const ADMIN_ENDPOINTS'), sec.indexOf('];', sec.indexOf('const ADMIN_ENDPOINTS')))
    expect(list).toContain("{ method: 'get', path: '/api/guest-waitlist' }")
    expect(list).toContain("{ method: 'delete', path: '/api/guest-waitlist/1' }")
    expect(list, 'the PUBLIC signup never joins ADMIN_ENDPOINTS').not.toMatch(/\/waitlist'/)
  })

  test('seams: the segment SQL is a code-comment contract (no helpers/segments.js); api.js has the three clients on the right request paths', () => {
    expect(existsSync(join(BACKEND_SRC, 'helpers', 'segments.js')), 'segments.js is module 21\'s file').toBe(false)
    const raw = readFileSync(join(BACKEND_SRC, 'helpers', 'guest-waitlist.js'), 'utf8')
    expect(raw).toContain('WHERE w.notified_at IS NULL AND w.whatsapp_opt_in = 1')
    expect(raw).toContain('AND w.phone_e164 IS NOT NULL AND f.active = 1')
    const api = readable(join(REPO_ROOT, 'frontend', 'src', 'api.js'), ['joinGuestWaitlist'])
    expect(api).toMatch(/joinGuestWaitlist: \(token, data\) => guestRequest\(`\/guest\/\$\{encodeURIComponent\(token\)\}\/waitlist`/)
    expect(api).toMatch(/return adminRequest\(`\/guest-waitlist\$\{qs \? `\?\$\{qs\}` : ''\}`\)/)
    expect(api).toMatch(/deleteGuestWaitlistRow: \(id\) => adminRequest\(`\/guest-waitlist\/\$\{id\}`, \{ method: 'DELETE' \}\)/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §8 GL-T6 · 19 §UC-GL-009 (UI) — CycleDetail.vue's „Čakajúci hostia (N)" card
// ═════════════════════════════════════════════════════════════════════════════
// The admin half of the waitlist: the rows IN FULL (name, phone, consent, dates),
// grouped by host, a per-row „Odstrániť" with an inline confirm and per-row pending
// (`rowSeq`). Cycle-INDEPENDENT data — every cycle's orders tab renders the same card.
//
// ⚠ The shared target carries OTHER files' waitlist rows (this file plants dozens), so
// every assertion is scoped to a planted row's own testid, and the „(N)" is compared
// with the admin GET read in the same breath. The empty state is reachable only by
// editing the real response (route.fetch-and-edit, never a hand-built stub).
// ⚠ ONE admin session app-wide: fixtures are built FIRST, then the UI login's token is
// adopted for every API read afterwards (the guest-admin-view.spec.js:820 trap).
const GL6_TITLE = (n) => `Čakajúci hostia (${n})`
const GL6_EMPTY = 'Nikto nečaká.'
const GL6_CONFIRM = 'Odstrániť tento záznam?'
const GL6_HEADERS = ['Meno', 'Mobil', 'WhatsApp', 'Zapísané', 'Upozornené']

// `plant()` with an explicit created_at, so the „Zapísané" date is a fixed string.
function plantAt(hostId, fields, createdAt) {
  const id = plant(hostId, fields)
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('UPDATE guest_waitlist SET created_at = ? WHERE id = ?').run(createdAt, id)
  } finally {
    db.close()
  }
  return id
}

async function gl6AdoptUi(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  const token = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(token, 'the UI login stored an admin token').toBeTruthy()
  adminToken = token
}

async function gl6OrdersTab(page, cycle) {
  await page.goto(`/admin/cycle/${cycle.id}`)
  await page.getByRole('tab', { name: 'Objednávky' }).click()
  const card = page.getByTestId('guest-waitlist-card')
  await expect(card).toBeVisible()
  return card
}

async function gl6Total() {
  const res = await admin('/api/guest-waitlist')
  expect(res.status()).toBe(200)
  return (await res.json()).rows.length
}

test.describe('GL-T6 · 19 §UC-GL-009 — CycleDetail „Čakajúci hostia (N)" card', () => {
  test.skip(!DB_PATH, NEEDS_DB)

  test('rows IN FULL, grouped by host: Meno · Mobil (E.164, else the raw phone) · WhatsApp áno/nie · Zapísané · Upozornené (date or —); the (N) is the whole list', async ({ page }) => {
    const alpha = await makeFriend('Card Alfa')
    const beta = await makeFriend('Card Beta')
    const cycle = await makeCycle('Card')
    const m1 = mobile(); const m3 = mobile()
    const r1 = plantAt(alpha.id, { name: 'Karta Jedna', phone: m1.national, e164: m1.e164, optIn: 1 }, '2026-09-10 10:00:00')
    const r2 = plantAt(alpha.id, { name: 'Karta Dva', phone: '12345', e164: null, optIn: 0, notified: '2026-09-01 10:00:00' }, '2026-08-20 10:00:00')
    const r3 = plantAt(beta.id, { name: 'Karta Tri', phone: m3.national, e164: m3.e164, optIn: 1 }, '2026-09-11 10:00:00')

    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)
    const card = await gl6OrdersTab(page, cycle)
    await expect(card.getByTestId('guest-waitlist-title')).toHaveText(GL6_TITLE(await gl6Total()))

    // Grouped by host: the host's name heads its group, and its rows sit INSIDE it.
    const groupA = card.getByTestId(`guest-waitlist-group-${alpha.id}`)
    const groupB = card.getByTestId(`guest-waitlist-group-${beta.id}`)
    await expect(groupA.getByTestId(`guest-waitlist-host-${alpha.id}`)).toHaveText(alpha.name)
    await expect(groupB.getByTestId(`guest-waitlist-host-${beta.id}`)).toHaveText(beta.name)
    await expect(groupA.getByTestId(`guest-waitlist-row-${r1}`)).toHaveCount(1)
    await expect(groupA.getByTestId(`guest-waitlist-row-${r2}`)).toHaveCount(1)
    await expect(groupB.getByTestId(`guest-waitlist-row-${r3}`)).toHaveCount(1)
    await expect(groupA.getByTestId(`guest-waitlist-row-${r3}`), 'a row never lands under another host').toHaveCount(0)

    // The five columns, in order (header of the group's table).
    const heads = await groupA.locator('th').allTextContents()
    expect(heads.map((h) => h.trim()).slice(0, 5)).toEqual(GL6_HEADERS)

    const cells = async (id) => (await card.getByTestId(`guest-waitlist-row-${id}`).getByRole('cell').allTextContents()).map((t) => t.trim())
    expect((await cells(r1)).slice(0, 5), 'E.164 shown; consented; never notified').toEqual(['Karta Jedna', m1.e164, 'áno', '10. 9. 2026', '—'])
    expect((await cells(r2)).slice(0, 5), 'no E.164 ⇒ the raw phone; no consent; notified').toEqual(['Karta Dva', '12345', 'nie', '20. 8. 2026', '1. 9. 2026'])
    // Newest first within a host (the API order is kept).
    const idsA = await groupA.locator('[data-testid^="guest-waitlist-row-"]').evaluateAll((els) => els.map((e) => e.dataset.testid))
    expect(idsA.indexOf(`guest-waitlist-row-${r1}`)).toBeLessThan(idsA.indexOf(`guest-waitlist-row-${r2}`))

    // Person-typed values are marked (FUP-T22): the name, the phone and the host name.
    for (const sel of [`guest-waitlist-row-${r1}`]) {
      const marked = await card.getByTestId(sel).locator('[data-user-copy]').allTextContents()
      expect(marked.map((t) => t.trim())).toEqual(expect.arrayContaining(['Karta Jedna', m1.e164]))
    }
    await expect(groupA.getByTestId(`guest-waitlist-host-${alpha.id}`)).toHaveAttribute('data-user-copy', '')
    await expect(card.getByTestId('guest-waitlist-empty')).toHaveCount(0)
  })

  test('cycle-INDEPENDENT: a second cycle\'s orders tab — a different status too — renders the same row', async ({ page }) => {
    const host = await makeFriend('Card Indep')
    const open = await makeCycle('Card Indep open')
    const done = await makeCycle('Card Indep done', 'completed')
    const m = mobile()
    const id = plantAt(host.id, { name: 'Všade Rovnaká', phone: m.national, e164: m.e164 }, '2026-09-12 10:00:00')

    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)
    const texts = []
    for (const cycle of [open, done]) {
      const card = await gl6OrdersTab(page, cycle)
      const row = card.getByTestId(`guest-waitlist-row-${id}`)
      await expect(row).toBeVisible()
      texts.push((await row.textContent()).trim())
    }
    expect(texts[1]).toBe(texts[0])
  })

  test('„Odstrániť": inline confirm; „Nie" backs out with NOTHING deleted; „Áno, odstrániť" removes the row from the card AND the DB, (N) and the host\'s waiting_count drop by one', async ({ page }) => {
    const host = await makeHost('Card Del')
    const cycle = await makeCycle('Card Del')
    const m1 = mobile(); const m2 = mobile()
    const gone = plant(host.id, { name: 'Zmazať Ma', phone: m1.national, e164: m1.e164 })
    const stays = plant(host.id, { name: 'Ostávam', phone: m2.national, e164: m2.e164 })
    const count0 = (await (await ctx.get('/api/guest-links/standing', { headers: host.auth })).json()).waiting_count
    expect(count0).toBe(2)

    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)
    const card = await gl6OrdersTab(page, cycle)
    const total = await gl6Total()
    await expect(card.getByTestId('guest-waitlist-title')).toHaveText(GL6_TITLE(total))

    const del = card.getByTestId(`guest-waitlist-delete-${gone}`)
    await expect(del).toHaveText('Odstrániť')
    await expect(card.getByTestId(`guest-waitlist-confirm-${gone}`)).toHaveCount(0)
    await del.click()
    const confirm = card.getByTestId(`guest-waitlist-confirm-${gone}`)
    await expect(confirm).toContainText(GL6_CONFIRM)
    await expect(del, 'the trigger yields to its confirmation').toHaveCount(0)
    await expect(card.getByTestId(`guest-waitlist-confirm-${stays}`), 'only THIS row asks').toHaveCount(0)

    await card.getByTestId(`guest-waitlist-no-${gone}`).click()
    await expect(confirm).toHaveCount(0)
    expect(rowsById(gone), '„Nie" deleted nothing — read back').toHaveLength(1)

    await card.getByTestId(`guest-waitlist-delete-${gone}`).click()
    await expect(card.getByTestId(`guest-waitlist-yes-${gone}`)).toHaveText('Áno, odstrániť')
    await card.getByTestId(`guest-waitlist-yes-${gone}`).click()
    await expect(card.getByTestId(`guest-waitlist-row-${gone}`)).toHaveCount(0)
    await expect(card.getByTestId(`guest-waitlist-row-${stays}`)).toBeVisible()
    await expect(card.getByTestId('guest-waitlist-title')).toHaveText(GL6_TITLE(total - 1))
    expect(rowsById(gone, stays).map((r) => r.id), 'the DB agrees').toEqual([stays])
    expect(await gl6Total()).toBe(total - 1)
    const count1 = (await (await ctx.get('/api/guest-links/standing', { headers: host.auth })).json()).waiting_count
    expect(count1, 'the host\'s count follows').toBe(1)
  })

  test('per-row pending (rowSeq): a HELD delete on row A never blocks row B; A is disabled AND JS-guarded (a dispatched click sends no second DELETE)', async ({ page }) => {
    const host = await makeFriend('Card Pend')
    const cycle = await makeCycle('Card Pend')
    const m1 = mobile(); const m2 = mobile()
    const a = plant(host.id, { name: 'Pomalá', phone: m1.national, e164: m1.e164 })
    const b = plant(host.id, { name: 'Rýchla', phone: m2.national, e164: m2.e164 })

    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)
    const deletes = []
    await page.route(`**/api/guest-waitlist/${a}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      deletes.push(a)
      await new Promise((r) => setTimeout(r, 15000))
      await route.continue().catch(() => {})
    })
    const card = await gl6OrdersTab(page, cycle)

    await card.getByTestId(`guest-waitlist-delete-${a}`).click()
    await card.getByTestId(`guest-waitlist-yes-${a}`).click()
    const yesA = card.getByTestId(`guest-waitlist-yes-${a}`)
    await expect(yesA).toHaveText('Odstraňujem...', { timeout: 3000 })
    await expect(yesA).toBeDisabled({ timeout: 3000 })

    // Row B, while A is still held: it completes on its own.
    await card.getByTestId(`guest-waitlist-delete-${b}`).click()
    await card.getByTestId(`guest-waitlist-yes-${b}`).click()
    await expect(card.getByTestId(`guest-waitlist-row-${b}`), 'B was not blocked by A').toHaveCount(0, { timeout: 3000 })
    expect(rowsById(b)).toHaveLength(0)
    await expect(card.getByTestId(`guest-waitlist-row-${a}`), 'A is still pending, still on screen').toBeVisible({ timeout: 1000 })

    // ⚠ A `disabled` attribute does not stop a DISPATCHED click (CLAUDE.md) — the JS guard does.
    await yesA.dispatchEvent('click')
    await page.waitForTimeout(300)
    expect(deletes, 'exactly ONE DELETE for row A').toEqual([a])
    expect(rowsById(a), 'A is not deleted yet — the request is held').toHaveLength(1)
  })

  test('a REFUSED delete keeps the row, says why on THAT row, and deleted nothing — read back', async ({ page }) => {
    const host = await makeFriend('Card Refuse')
    const cycle = await makeCycle('Card Refuse')
    const m = mobile()
    const id = plant(host.id, { name: 'Neodstrániteľná', phone: m.national, e164: m.e164 })

    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)
    await page.route(`**/api/guest-waitlist/${id}`, (route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Server je nedostupný' }) })
    })
    const card = await gl6OrdersTab(page, cycle)
    await card.getByTestId(`guest-waitlist-delete-${id}`).click()
    await card.getByTestId(`guest-waitlist-yes-${id}`).click()
    await expect(card.getByTestId(`guest-waitlist-row-error-${id}`)).toContainText('Server je nedostupný')
    await expect(card.getByTestId(`guest-waitlist-row-${id}`), 'never shown as done').toBeVisible()
    expect(rowsById(id)).toHaveLength(1)
  })

  test('empty ⇒ „Nikto nečaká." and (0), no table; a FAILED load is NOT the empty state', async ({ page }) => {
    const cycle = await makeCycle('Card Empty')
    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)

    await page.route('**/api/guest-waitlist', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      expect(Array.isArray(body.rows), 'the real payload was fetched').toBe(true)
      body.rows = []
      await route.fulfill({ response: res, body: JSON.stringify(body) })
    })
    let card = await gl6OrdersTab(page, cycle)
    await expect(card.getByTestId('guest-waitlist-empty')).toHaveText(GL6_EMPTY)
    await expect(card.getByTestId('guest-waitlist-title')).toHaveText(GL6_TITLE(0))
    await expect(card.locator('table')).toHaveCount(0)
    await expect(card.getByTestId('guest-waitlist-error')).toHaveCount(0)

    await page.unroute('**/api/guest-waitlist')
    await page.route('**/api/guest-waitlist', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Chyba servera' }) }))
    card = await gl6OrdersTab(page, cycle)
    await expect(card.getByTestId('guest-waitlist-error')).toContainText('Chyba servera')
    await expect(card.getByTestId('guest-waitlist-empty'), 'a failed load never reads as „nobody waits"').toHaveCount(0)
    await expect(card.getByTestId('guest-waitlist-title'), 'no count is claimed').toHaveText('Čakajúci hostia')

    // (No in-flight state to pin: `loadAll()` awaits the listing behind the page's own
    // „Načítavam...", the precedent `loadGuestUnpaid()` / `loadGuestLinks()` follow,
    // so the card never renders before the list or the failure has arrived.)
  })
})
