// Module 21 — WA-T3: 21 §UC-WA-005 (`helpers/segments.js`, the recipient lists),
// §UC-WA-007 (the `waitlist:<cycle>` SEGMENT only — compose/release are WA-T5's) and
// the two READ routes of §UC-WA-008:
//   GET /api/notifications/segments?cycle_id=[&segment_key=]
//   GET /api/notifications?cycle_id=&segment_key=
// as amended by „PO decisions 2026-09-19": a friend's `{suma}` is the LEDGER balance
// owed (NOTHING_OWED when the balance is ≥ 0), a guest's is the sub-order amount incl.
// the Packeta fee (NOTHING_OWED once paid).
//
// THREE KINDS OF EVIDENCE, each where only it can work:
//   §1 THROWAWAY BOOTS — a child `node` imports `db/schema.js` + `helpers/segments.js`
//      against a temp file (the `guest-standing-link.spec.js` probe idiom). This is the
//      only place the IN-PROCESS seam WA-T4/WA-T5 consume is visible: the `NOTHING_OWED`
//      Symbol itself, the composed `{odkaz}` values (which the JSON preview deliberately
//      never publishes), the `opted_out` list, and Bratislava-midnight edges that need a
//      hand-written UTC stamp. Fixtures are SQL inserts into a database nobody serves.
//   §2 HTTP on the gate server — fixtures built through the REAL routes (module 16's
//      hand-over endpoints, the guest checkout, the admin friend PATCH), asserted through
//      the two read routes. Unique names; membership asserted by id, never a global count
//      (the shared target holds every other spec's friends and waitlist rows).
//   §3 DB_PATH-gated HTTP — „handed over YESTERDAY" (no route can back-date a stamp) and
//      the waitlist rows (the public signup 409s while ANY round is open, and the shared
//      target always has one), written with `node:sqlite` into the served database.
//
// ⚠ THE JSON BOUNDARY (decided in WA-T3, learnings 15 §WA-T3): `JSON.stringify` DROPS a
// Symbol-valued key, so `vars.suma = NOTHING_OWED` would silently vanish and read like
// „no value" (= literal `{suma}`, release-blocking) — the opposite meaning. The preview
// therefore serialises NOTHING_OWED as `null` (key present), a formatted amount as the
// string, and never publishes `vars.odkaz` at all (a guest's `order_token`, a host's
// standing token): it carries `odkaz_resolved: boolean` instead.

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'
const TIMEOUT = 20_000
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src')
// Gated on schema.js (the backend tree), NOT on segments.js: a gate on the new file
// would skip silently the day it is deleted (learnings 15 §WA-T2 trap).
const HAS_BACKEND_SRC = existsSync(join(BACKEND_SRC, 'db', 'schema.js'))
const NEEDS_BACKEND_SRC = 'needs the backend source beside e2e/ (skipped against a deployment)'
const srcUrl = (rel) => pathToFileURL(join(BACKEND_SRC, rel)).href
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// The Europe/Bratislava calendar day of a SQLite UTC stamp (`YYYY-MM-DD HH:MM:SS`) —
// an INDEPENDENT copy of the rule (the spec must not import what it tests).
function bratislavaDate(stamp) {
  const instant = new Date(`${String(stamp).replace(' ', 'T')}Z`)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant)
}
const dm = (iso) => `${Number(iso.slice(8, 10))}. ${Number(iso.slice(5, 7))}.`
const money = (n) => `${n.toFixed(2).replace('.', ',')} €`

// ═════════════════════════════════════════════════════════════════════════════
// §1 THROWAWAY BOOTS
// ═════════════════════════════════════════════════════════════════════════════
const PROBE_BASE = 'https://probe.example'

function probe(body) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t3-probe-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    `import db from '${srcUrl('db/schema.js')}';\n`
      + `import * as seg from '${srcUrl('helpers/segments.js')}';\n`
      + `import * as tr from '${srcUrl('helpers/template-render.js')}';\n`
      + `const out = (() => {\n${body}\n})();\n`
      + `console.log('@@PROBE@@' + JSON.stringify(out));\n`,
  )
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: { ...process.env, DB_PATH: join(dir, 'probe.sqlite'), PUBLIC_BASE_URL: PROBE_BASE },
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

// One fixture world, built by SQL in every probe (each probe is its own fresh file).
// Stamps are UTC as SQLite stores them; 2026-10-23/24 are CEST (UTC+2), so
// `2026-10-23 22:30:00` is 00:30 on the 24th in Bratislava and `21:59:59` is still the 23rd.
const WORLD = `
  const ins = (sql, p = []) => db.run(sql, p).lastInsertRowid;
  const cyc = ins("INSERT INTO order_cycles (name, status, closes_at) VALUES ('Probe objednávka', 'open', '2026-11-06')");
  const other = ins("INSERT INTO order_cycles (name, status) VALUES ('Iná objednávka', 'open')");
  const prod = ins('INSERT INTO products (cycle_id, name, price_250g, price_1kg) VALUES (?, ?, 10, 30)', [cyc, 'Káva']);
  const loc = ins("INSERT INTO pickup_locations (name, address) VALUES ('Kaviareň Probe', 'Hlavná 1')");
  let n = 0;
  const friend = (name, extra = {}) => ins(
    'INSERT INTO friends (name, cycle_id, access_token, phone, phone_e164, email, whatsapp_opt_in, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [name, cyc, 'acc-' + (++n), extra.phone ?? '0905 000 00' + n, 'phone_e164' in extra ? extra.phone_e164 : '+42190500000' + n,
     extra.email ?? null, extra.opt_in ?? 1, extra.active ?? 1]);
  const order = (friendId, extra = {}) => {
    const id = ins(
      'INSERT INTO orders (friend_id, cycle_id, status, total, pickup_location_id, pickup_location_note, packeta_address, handed_over_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [friendId, extra.cycle ?? cyc, extra.status ?? 'submitted', 10, extra.loc ?? null, extra.note ?? null, extra.packeta ?? null, extra.at ?? null]);
    if (extra.items !== 0) ins("INSERT INTO order_items (order_id, product_id, variant, quantity, price) VALUES (?, ?, '250g', 1, 10)", [id, prod]);
    return id;
  };
  const W = {};
  W.A = friend('Alena Prvá');            W.oA = order(W.A, { loc, at: '2026-10-24 08:00:00' });
  W.B = friend('Boris Druhý');           W.oB = order(W.B, { loc, at: '2026-10-23 22:30:00' });
  ins("INSERT INTO transactions (friend_id, type, amount) VALUES (?, 'charge', -12.5)", [W.B]);
  W.C = friend('Cyril Tretí');           W.oC = order(W.C, { loc, at: '2026-10-23 21:59:59' });
  W.D = friend('Dana Zimná');            W.oD = order(W.D, { loc, at: '2026-12-31 23:30:00' });
  ins("INSERT INTO transactions (friend_id, type, amount) VALUES (?, 'payment', 4)", [W.C]);
  W.O = friend('Olga Bezsúhlasu', { opt_in: 0, email: 'olga@example.test' });
  W.oO = order(W.O, { loc, at: '2026-10-24 09:00:00' });
  W.I = friend('Igor Neaktívny', { active: 0 }); W.oI = order(W.I, { loc, at: '2026-10-24 09:00:00' });
  W.NP = friend('Nina Bezčísla', { phone: '123', phone_e164: null }); W.oNP = order(W.NP, { loc, at: '2026-10-24 10:00:00' });
  W.P = friend('Pavol Packeta');         W.oP = order(W.P, { packeta: 'Z-BOX Probe 7', at: '2026-10-24 11:00:00' });
  W.IP = friend('Iveta Osobne');         W.oIP = order(W.IP, { note: 'odovzdám osobne', at: '2026-10-24 11:00:00' });
  W.UN = friend('Ulrich Neodovzdaný');   W.oUN = order(W.UN, { loc });
  W.H = friend('Hana Hostiteľka');       W.oH = order(W.H, { loc, at: '2026-10-24 12:00:00' });
  W.H2 = friend('Hugo Bezodkazu');
  W.HX = friend('Xénia Neaktívna', { active: 0 });
  db.run('UPDATE friends SET guest_link_token = ? WHERE id = ?', ['STANDINGPROBETOKEN1', W.H]);
  db.run('UPDATE friends SET guest_link_token = ? WHERE id = ?', ['STANDINGPROBETOKEN2', W.HX]);
  const link = ins('INSERT INTO guest_order_links (token, host_friend_id, cycle_id) VALUES (?, ?, ?)', ['LINKPROBE1', W.H, cyc]);
  const guest = (name, extra = {}) => ins(
    'INSERT INTO guest_orders (link_id, order_token, guest_name, guest_phone, phone_e164, guest_email, status, total, paid, delivery_fee, packeta_address, handed_over_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [link, 'ORDTOK' + (++n), name, '0910 000 00' + n, 'phone_e164' in extra ? extra.phone_e164 : '+42191000000' + n, extra.email ?? null,
     extra.status ?? 'submitted', extra.total ?? 20, extra.paid ?? 0, extra.fee ?? 0, extra.packeta ?? null, extra.at ?? null]);
  W.G1 = guest('Gabika Hosťová', { at: '2026-10-24 12:00:00', total: 15.5 });
  W.G2 = guest('Gejza Zrušený', { at: '2026-10-24 12:00:00', status: 'cancelled', total: 0 });
  W.G3 = guest('Gita Zaplatená', { at: '2026-10-24 12:00:00', paid: 1 });
  W.GP = guest('Gustáv Packeta', { at: '2026-10-24 13:00:00', packeta: 'Z-BOX Hosť 9', fee: 3.9, email: 'g@example.test' });
  W.GP2 = guest('Gréta Packeta Zaplatená', { at: '2026-10-24 13:00:00', packeta: 'Z-BOX Hosť 10', fee: 3.9, paid: 1 });
  W.GPX = guest('Gerda Packeta Zrušená', { at: '2026-10-24 13:00:00', packeta: 'Z-BOX Hosť 11', status: 'cancelled', total: 0 });
  W.GN = guest('Gabo Bezčísla', { at: '2026-10-24 12:00:00', phone_e164: null });
  // not_ordered: an auto-saved EMPTY draft counts as not ordered; a draft WITH an item does not.
  W.NE = friend('Norbert Prázdny');      W.oNE = order(W.NE, { status: 'draft', items: 0 });
  W.NN = friend('Natália Bezobjednávky');
  W.NO = friend('Noemi Inde');           W.oNO = order(W.NO, { cycle: other });
  W.DR = friend('Dávid Rozpracovaný');   W.oDR = order(W.DR, { status: 'draft' });
  // waitlist
  const wait = (host, name, extra = {}) => ins(
    'INSERT INTO guest_waitlist (host_friend_id, cycle_id, name, phone, phone_e164, whatsapp_opt_in, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [host, other, name, '0911 000 00' + (++n), 'phone_e164' in extra ? extra.phone_e164 : '+42191100000' + n, extra.opt_in ?? 1, extra.notified ?? null]);
  W.W1 = wait(W.H, 'Waldemar Čakajúci');
  W.W2 = wait(W.H, 'Wanda Upozornená', { notified: '2026-10-20 10:00:00' });
  W.W3 = wait(W.H, 'Werner Bezsúhlasu', { opt_in: 0 });
  W.W4 = wait(W.H, 'Wilma Bezčísla', { phone_e164: null });
  W.W5 = wait(W.H2, 'Walter Nemintnutý');
  W.W6 = wait(W.HX, 'Wendy Neaktívny hostiteľ');
`

const ids = (seg) => seg.recipients.map((r) => `${r.recipient_kind}:${r.recipient_id}`)

test.describe('WA-T3 · §1 throwaway boots — helpers/segments.js in-process', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('hand-over grouping is by the Europe/Bratislava calendar day of `handed_over_at` (UTC stored), consent-filtered, opted-out counted', () => {
    const out = probe(`${WORLD}
      const base = { baseUrl: '${PROBE_BASE}' };
      const today = seg.buildSegment(cyc, 'handed_over:pickup:' + loc + ':2026-10-24', base);
      const yday = seg.buildSegment(cyc, 'handed_over:pickup:' + loc + ':2026-10-23', base);
      const ny = seg.buildSegment(cyc, 'handed_over:pickup:' + loc + ':2027-01-01', base);
      const none = seg.buildSegment(cyc, 'handed_over:pickup:' + loc + ':2026-10-22', base);
      const pick = (s) => s && { key: s.key, name: s.name, template_key: s.template_key, ids: s.recipients.map((r) => r.recipient_kind + ':' + r.recipient_id),
        excluded: s.excluded_opt_out, no_phone: s.no_phone, opted_out: s.opted_out.map((r) => r.recipient_id) };
      return { W, loc, today: pick(today), yday: pick(yday), ny: pick(ny), none: pick(none) };
    `)
    const { W } = out
    // A at 08:00 UTC and B at 22:30 UTC the day BEFORE are both the 24th in Bratislava;
    // NP (no number) is RETURNED, the opted-out O is counted, the inactive I vanishes.
    expect(out.today.ids).toEqual([`friend:${W.A}`, `friend:${W.B}`, `friend:${W.H}`, `friend:${W.NP}`])
    expect(out.today.key).toBe(`handed_over:pickup:${out.loc}:2026-10-24`)
    expect(out.today.name).toBe('Kaviareň Probe — odovzdané 24. 10.')
    expect(out.today.template_key).toBe('pickup')
    expect(out.today.excluded, 'O opted out; the inactive friend is NOT counted').toBe(1)
    expect(out.today.opted_out, 'WA-T4 seam: the opted-out recipients, in full, in-process').toEqual([W.O])
    expect(out.today.no_phone).toBe(1)
    // 21:59:59 UTC on the 23rd is 23:59:59 CEST — still the 23rd.
    expect(out.yday.ids).toEqual([`friend:${W.C}`])
    // Winter (CET, UTC+1): 23:30 UTC on 31 Dec is already New Year in Bratislava.
    expect(out.ny.ids).toEqual([`friend:${W.D}`])
    expect(out.ny.name).toBe('Kaviareň Probe — odovzdané 1. 1.')
    expect(out.none.ids, 'a valid day with nobody handed over is an EMPTY group, not null').toEqual([])
  })

  test('per-recipient vars: {suma} = ledger owed (the NOTHING_OWED Symbol itself when ≥ 0), {miesto}, {odkaz} = login root, {datum}, {objednávka}', () => {
    const out = probe(`${WORLD}
      const s = seg.buildSegment(cyc, 'handed_over:pickup:' + loc + ':2026-10-24', { baseUrl: '${PROBE_BASE}' });
      const yd = seg.buildSegment(cyc, 'handed_over:pickup:' + loc + ':2026-10-23', { baseUrl: '${PROBE_BASE}' });
      const byId = Object.fromEntries([...s.recipients, ...yd.recipients].map((r) => [r.recipient_id, r]));
      const A = byId[W.A], B = byId[W.B], C = byId[W.C];
      return {
        aSumaIsSymbol: A.vars.suma === tr.NOTHING_OWED, cSumaIsSymbol: C.vars.suma === tr.NOTHING_OWED,
        bSuma: B.vars.suma, aVars: { ...A.vars, suma: null }, A: { ...A, vars: null },
      };
    `)
    expect(out.aSumaIsSymbol, 'balance 0 ⇒ the registered NOTHING_OWED Symbol (WA-T2 seam), not a string').toBe(true)
    expect(out.cSumaIsSymbol, 'balance +4 (credit) ⇒ NOTHING_OWED too').toBe(true)
    expect(out.bSuma, 'balance −12.5 ⇒ the formatted debt').toBe('12,50 €')
    expect(out.aVars).toEqual({
      meno: 'Alena', 'objednávka': 'Probe objednávka', miesto: 'Kaviareň Probe (Hlavná 1)', suma: null,
      odkaz: PROBE_BASE, datum: 'v piatok 6. 11.',
    })
    expect(out.A).toMatchObject({
      recipient_kind: 'friend', name: 'Alena Prvá', phone_e164: expect.stringMatching(/^\+421/), opt_in: 1,
      guest_order_id: null, email: null,
    })
    expect(out.A.order_id).toBeGreaterThan(0)
  })

  test('handed_over:packeta merges friend AND own-Packeta guest parties (separate query, JS merge); cancelled sub-orders nowhere; guest {suma} = total + fee, NOTHING_OWED once paid', () => {
    const out = probe(`${WORLD}
      const s = seg.buildSegment(cyc, 'handed_over:packeta:2026-10-24', { baseUrl: '${PROBE_BASE}' });
      const hg = seg.buildSegment(cyc, 'host_guests:' + W.H + ':2026-10-24', { baseUrl: '${PROBE_BASE}' });
      const r = (x, id, kind) => x.recipients.find((q) => q.recipient_kind === kind && q.recipient_id === id);
      const gp = r(s, W.GP, 'guest'), gp2 = r(s, W.GP2, 'guest'), g1 = r(hg, W.G1, 'guest'), g3 = r(hg, W.G3, 'guest');
      return {
        W, packeta: { name: s.name, template_key: s.template_key, ids: s.recipients.map((q) => q.recipient_kind + ':' + q.recipient_id) },
        host: { name: hg.name, template_key: hg.template_key, ids: hg.recipients.map((q) => q.recipient_kind + ':' + q.recipient_id), no_phone: hg.no_phone, excluded: hg.excluded_opt_out },
        gp: { ...gp, vars: { ...gp.vars } }, gp2Paid: gp2.vars.suma === tr.NOTHING_OWED,
        g1: { ...g1, vars: { ...g1.vars } }, g3Paid: g3.vars.suma === tr.NOTHING_OWED,
        pMiesto: r(s, W.P, 'friend').vars.miesto,
      };
    `)
    const { W } = out
    expect(out.packeta.template_key).toBe('packeta')
    expect(out.packeta.name).toBe('Packeta — odovzdané 24. 10.')
    // Sorted by name across both kinds; the cancelled Packeta guest is absent.
    expect(out.packeta.ids).toEqual([`guest:${W.GP2}`, `guest:${W.GP}`, `friend:${W.P}`])
    expect(out.pMiesto).toBe('Z-BOX Probe 7')
    expect(out.gp).toMatchObject({
      recipient_kind: 'guest', recipient_id: W.GP, guest_order_id: W.GP, order_id: null, opt_in: null,
      name: 'Gustáv Packeta', email: 'g@example.test',
    })
    expect(out.gp.vars).toEqual({
      meno: 'Gustáv', 'objednávka': 'Probe objednávka', miesto: 'Z-BOX Hosť 9', suma: '23,90 €',
      odkaz: `${PROBE_BASE}/g/o/ORDTOK${out.gp.vars.odkaz.split('ORDTOK')[1]}`, host: 'Hana', datum: 'v piatok 6. 11.',
    })
    expect(out.gp.vars.odkaz).toMatch(new RegExp(`^${PROBE_BASE.replace(/\./g, '\\.')}/g/o/ORDTOK\\d+$`))
    expect(out.gp2Paid, 'a PAID guest owes nothing ⇒ NOTHING_OWED').toBe(true)

    // host_guests: via_host only (the Packeta guests are their OWN party), the cancelled
    // G2 is absent although it still carries `handed_over_at` (the DP-T3 seam), the
    // no-number guest is returned.
    expect(out.host.template_key).toBe('host')
    expect(out.host.name).toBe('Hostia Hana — odovzdané hostiteľovi')
    expect(out.host.ids.sort()).toEqual([`guest:${W.G1}`, `guest:${W.G3}`, `guest:${W.GN}`].sort())
    expect(out.host.no_phone).toBe(1)
    expect(out.host.excluded, 'guests have no opt-in flag (D6)').toBe(0)
    expect(out.g1.vars.suma, 'via_host: total, no fee').toBe('15,50 €')
    expect(out.g1.vars.host).toBe('Hana')
    expect(out.g1.vars.miesto, '{miesto} has no source for a via_host guest ⇒ unresolved').toBeUndefined()
    expect(out.g3Paid).toBe(true)
  })

  test('in_person enqueues to no segment: handOverSegmentKey() is null for it, and a keyed one for the other three', () => {
    const out = probe(`
      return {
        inPerson: seg.handOverSegmentKey({ delivery: { type: 'in_person', target_key: 'in_person' }, handedOverAt: '2026-10-24 08:00:00' }),
        pickup: seg.handOverSegmentKey({ delivery: { type: 'pickup', target_key: 'loc7' }, handedOverAt: '2026-10-23 22:30:00' }),
        packeta: seg.handOverSegmentKey({ delivery: { type: 'packeta', target_key: 'packeta' }, handedOverAt: '2026-10-24 08:00:00' }),
        host: seg.handOverSegmentKey({ delivery: { type: 'via_host', target_key: 'loc7' }, handedOverAt: '2026-10-24 08:00:00', hostFriendId: 12 }),
        hostNoHost: seg.handOverSegmentKey({ delivery: { type: 'via_host', target_key: 'loc7' }, handedOverAt: '2026-10-24 08:00:00' }),
        noStamp: seg.handOverSegmentKey({ delivery: { type: 'pickup', target_key: 'loc7' }, handedOverAt: null }),
      };
    `)
    expect(out).toEqual({
      inPerson: null,
      pickup: 'handed_over:pickup:7:2026-10-24',
      packeta: 'handed_over:packeta:2026-10-24',
      host: 'host_guests:12:2026-10-24',
      hostNoHost: null,
      noStamp: null,
    })
  })

  test('not_ordered: an auto-saved EMPTY order is „not ordered", a row with ≥ 1 item is ordered; all_active = every active consenting friend', () => {
    const out = probe(`${WORLD}
      const no = seg.buildSegment(cyc, 'not_ordered:' + cyc, { baseUrl: '${PROBE_BASE}' });
      const all = seg.buildSegment(null, 'all_active', { baseUrl: '${PROBE_BASE}' });
      const r = no.recipients.find((q) => q.recipient_id === W.NE);
      return { W, no: { name: no.name, template_key: no.template_key, ids: no.recipients.map((q) => q.recipient_id), excluded: no.excluded_opt_out },
        all: { name: all.name, template_key: all.template_key, ids: all.recipients.map((q) => q.recipient_id), excluded: all.excluded_opt_out },
        neVars: r ? { ...r.vars, suma: r.vars.suma === tr.NOTHING_OWED ? 'NOTHING_OWED' : r.vars.suma } : null };
    `)
    const { W } = out
    expect(out.no.template_key).toBe('closing')
    expect(out.no.name).toBe('Neobjednali (otvorená objednávka)')
    expect(out.no.ids).toContain(W.NE) // empty auto-saved draft
    expect(out.no.ids).toContain(W.NN) // no row at all
    expect(out.no.ids).toContain(W.NO) // ordered in ANOTHER round only
    expect(out.no.ids).toContain(W.H2)
    for (const id of [W.A, W.UN, W.DR, W.H]) expect(out.no.ids, `friend ${id} has an order with items`).not.toContain(id)
    expect(out.no.ids, 'inactive').not.toContain(W.HX)
    expect(out.no.ids, 'opted out').not.toContain(W.O)
    expect(out.no.excluded, 'the opted-out O has an order; only consent-less non-orderers count — none here').toBe(0)
    expect(out.neVars).toEqual({ meno: 'Norbert', 'objednávka': 'Probe objednávka', suma: 'NOTHING_OWED', odkaz: PROBE_BASE, datum: 'v piatok 6. 11.' })

    expect(out.all.template_key).toBe('custom')
    expect(out.all.name).toBe('Všetci aktívni priatelia')
    expect(out.all.ids).not.toContain(W.O)
    expect(out.all.ids).not.toContain(W.I)
    expect(out.all.ids).not.toContain(W.HX)
    expect(out.all.ids).toContain(W.A)
    expect(out.all.excluded).toBe(1)
  })

  test('waitlist: un-notified + opted-in rows of ACTIVE hosts; no-phone RETURNED; {odkaz} = the standing URL, EMPTY for an un-minted host — and a read never mints', () => {
    const out = probe(`${WORLD}
      const before = db.get('SELECT total_changes() AS n').n;
      const s = seg.buildSegment(cyc, 'waitlist:' + cyc, { baseUrl: '${PROBE_BASE}' });
      seg.computedSegments(cyc, { baseUrl: '${PROBE_BASE}' });
      for (const k of ['handed_over:pickup:' + loc + ':2026-10-24', 'handed_over:packeta:2026-10-24', 'host_guests:' + W.H + ':2026-10-24', 'not_ordered:' + cyc, 'all_active']) seg.buildSegment(cyc, k, {});
      const after = db.get('SELECT total_changes() AS n').n;
      const r = (id) => s.recipients.find((q) => q.recipient_id === id);
      return { W, name: s.name, template_key: s.template_key, ids: s.recipients.map((q) => q.recipient_kind + ':' + q.recipient_id),
        excluded: s.excluded_opt_out, no_phone: s.no_phone, w1: r(W.W1), w5odkaz: r(W.W5).vars.odkaz, w4: r(W.W4),
        h2Token: db.get('SELECT guest_link_token FROM friends WHERE id = ?', [W.H2]).guest_link_token,
        writes: after - before };
    `)
    const { W } = out
    expect(out.template_key).toBe('waitlist')
    expect(out.name).toBe('Čakajúci hostia')
    expect(out.ids.sort()).toEqual([`waitlist:${W.W1}`, `waitlist:${W.W4}`, `waitlist:${W.W5}`].sort())
    expect(out.excluded, 'W3 gave no consent').toBe(1)
    expect(out.no_phone, 'W4 is returned with phone_e164 null (21 §UC-WA-005 number predicate)').toBe(1)
    expect(out.w4.phone_e164).toBe(null)
    expect(out.w1).toMatchObject({ recipient_kind: 'waitlist', recipient_id: W.W1, name: 'Waldemar Čakajúci', opt_in: 1, order_id: null, guest_order_id: null, email: null })
    expect(out.w1.vars).toEqual({
      meno: 'Waldemar', host: 'Hana', odkaz: `${PROBE_BASE}/g/STANDINGPROBETOKEN1`, 'objednávka': 'Probe objednávka', datum: 'v piatok 6. 11.',
    })
    expect(out.w5odkaz, 'un-minted host ⇒ empty ⇒ the body keeps literal {odkaz} ⇒ release refuses (§UC-WA-007)').toBe('')
    expect(out.h2Token, 'the READ path never mints a standing token').toBe(null)
    expect(out.writes, 'segments.js is read-only: zero row changes across every builder').toBe(0)
  })

  test('the default base URL is resolveLoginUrl() (PUBLIC_BASE_URL); computedSegments lists exactly the three composer-built kinds', () => {
    const out = probe(`${WORLD}
      const s = seg.buildSegment(cyc, 'not_ordered:' + cyc);
      const c = seg.computedSegments(cyc);
      return { odkaz: s.recipients[0].vars.odkaz, computed: c };
    `)
    expect(out.odkaz).toBe(PROBE_BASE)
    expect(out.computed.map((c) => c.key)).toEqual([expect.stringMatching(/^not_ordered:\d+$/), expect.stringMatching(/^waitlist:\d+$/), 'all_active'])
    for (const c of out.computed) {
      expect(Object.keys(c).sort()).toEqual(['count', 'excluded_opt_out', 'key', 'name', 'no_phone', 'requires_open_cycle', 'template_enabled', 'template_key'])
    }
    expect(out.computed.map((c) => c.template_enabled), 'seed: closing off, waitlist off, custom on').toEqual([false, false, true])
    expect(out.computed.map((c) => c.requires_open_cycle)).toEqual([true, true, false])
  })

  test('parseSegmentKey / isSegmentKey: the §UC-WA-008 grammar (≤ 80) and the six kinds; anything else is null', () => {
    const out = probe(`
      const keys = ['all_active', 'not_ordered:5', 'waitlist:5', 'handed_over:pickup:3:2026-10-24', 'handed_over:packeta:2026-10-24',
        'host_guests:9:2026-10-24', 'handed_over:in_person:2026-10-24', 'handed_over:pickup:0:2026-10-24', 'handed_over:pickup:3:2026-02-31',
        'handed_over:pickup:abc:2026-10-24', 'not_ordered:abc', 'not_ordered', 'all_active:1', 'loc5', 'host:7', 'packeta',
        'Bad Key', 'a::b', 'x:', 'x'.repeat(81), 123];
      return keys.map((k) => [k, seg.isSegmentKey(k), seg.parseSegmentKey(k)]);
    `)
    const by = Object.fromEntries(out.map(([k, valid, parsed]) => [String(k), { valid, parsed }]))
    expect(by.all_active.parsed).toEqual({ kind: 'all_active' })
    expect(by['not_ordered:5'].parsed).toEqual({ kind: 'not_ordered', cycleId: 5 })
    expect(by['waitlist:5'].parsed).toEqual({ kind: 'waitlist', cycleId: 5 })
    expect(by['handed_over:pickup:3:2026-10-24'].parsed).toEqual({ kind: 'handed_over_pickup', locationId: 3, date: '2026-10-24' })
    expect(by['handed_over:packeta:2026-10-24'].parsed).toEqual({ kind: 'handed_over_packeta', date: '2026-10-24' })
    expect(by['host_guests:9:2026-10-24'].parsed).toEqual({ kind: 'host_guests', hostFriendId: 9, date: '2026-10-24' })
    for (const k of ['handed_over:pickup:0:2026-10-24', 'handed_over:pickup:3:2026-02-31', 'handed_over:pickup:abc:2026-10-24',
      'not_ordered:abc', 'not_ordered', 'all_active:1', 'host:7', 'packeta']) {
      expect(by[k].valid, `${k} is grammatical`).toBe(true)
      expect(by[k].parsed, `${k} is no segment of 21 §UC-WA-005`).toBe(null)
    }
    // ⚠ DP-T3's `loc<id>` is NOT grammatical (a digit in the kind), nor is anything with
    // an `_` in a qualifier (`in_person`) — the §UC-WA-008 pattern is `[a-z_]+` then
    // `[A-Za-z0-9-]+` per qualifier.
    for (const k of ['loc5', 'handed_over:in_person:2026-10-24', 'Bad Key', 'a::b', 'x:', 'x'.repeat(81), '123']) {
      expect(by[k].valid, `${k} is not grammatical`).toBe(false)
      expect(by[k].parsed).toBe(null)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 HTTP — the gate server
// ═════════════════════════════════════════════════════════════════════════════
let ctx = null
let adminToken = ''
const admin = makeAdmin({ ctx: () => ctx, token: () => adminToken, adopt: (t) => { adminToken = t }, timeout: TIMEOUT })

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})
test.afterAll(async () => { await ctx?.dispose() })

let friendSeq = 0
async function makeFriend(label, phone) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `wa3_${label.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  // First name = the first token — unique per run, so `{meno}`/`{host}` are assertable.
  const first = `W3${label}${uniq}${friendSeq}`
  const name = `${first} Test`
  const created = await admin('/api/friends', { method: 'post', data: phone ? { name, phone } : { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()
  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token
  return { id: row.id, name, first, phone: phone || null, auth: { Authorization: `Bearer ${token}` } }
}

async function cart(friend, cycleId, items) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, { headers: friend.auth, data: { items }, timeout: TIMEOUT })
  expect(put.status(), 'cart PUT').toBe(200)
}
async function ownOrder(friend, cycleId, items, submitBody) {
  await cart(friend, cycleId, items)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, { headers: friend.auth, data: submitBody, timeout: TIMEOUT })
  expect(res.status(), 'submit').toBe(200)
  return (await res.json()).order
}
async function distribution(cycleId) {
  const res = await admin(`/api/cycles/${cycleId}/distribution`)
  expect(res.status()).toBe(200)
  return res.json()
}
async function packFriend(cycleId, friend, orderId) {
  const party = (await distribution(cycleId)).distribution.find((p) => p.id === friend.id && p.kind === 'friend')
  for (const g of party.guest_orders) {
    for (const item of g.items) if (!item.packed) expect((await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  }
  for (const item of party.items) if (!item.packed) expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  expect((await admin(`/api/orders/${orderId}/packed`, { method: 'patch' })).status(), 'order packed').toBe(200)
}
async function packGuestParty(cycleId, guestOrderId) {
  const party = (await distribution(cycleId)).distribution.find((p) => p.kind === 'guest' && p.guest_order_id === guestOrderId)
  expect(party, 'the Packeta guest is its own party').toBeTruthy()
  for (const item of party.items) if (!item.packed) expect((await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
}
async function handOver(orderId) {
  const res = await admin(`/api/orders/${orderId}/handed-over`, { method: 'patch', data: { handed_over: true } })
  expect(res.status(), 'hand-over').toBe(200)
  return (await res.json()).order.handed_over_at
}
async function handOverGuest(guestOrderId) {
  const res = await admin(`/api/guest-orders/${guestOrderId}/handed-over`, { method: 'patch', data: { handed_over: true } })
  expect(res.status(), 'guest hand-over').toBe(200)
  return (await res.json()).guest_order.handed_over_at
}
async function segments(cycleId, segmentKey) {
  const params = { cycle_id: String(cycleId) }
  if (segmentKey !== undefined) params.segment_key = segmentKey
  const res = await admin('/api/notifications/segments', { params })
  expect(res.status(), `GET /segments ${segmentKey || ''}`).toBe(200)
  return res.json()
}
async function preview(cycleId, key) {
  const body = await segments(cycleId, key)
  expect(body.segment, 'the preview of the requested segment').toBeTruthy()
  return body.segment
}
const rec = (segment, kind, id) => segment.recipients.find((r) => r.recipient_kind === kind && r.recipient_id === id)
async function owedOf(friendId) {
  const res = await admin(`/api/friends/${friendId}/detail`)
  expect(res.status()).toBe(200)
  return -(await res.json()).friend.balance
}

test.describe('WA-T3 · §2 the read routes over real hand-overs (module 16 routes, guest checkout, admin opt-out)', () => {
  test.describe.configure({ mode: 'serial' })
  const fx = {}

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    const cycle = await admin('/api/cycles', {
      method: 'post', data: { name: `E2E WA3 ${uniq}`, type: 'coffee', status: 'open', closes_at: '2026-11-06' },
    })
    expect(cycle.status()).toBe(201)
    fx.cycle = await cycle.json()
    expect((await admin(`/api/cycles/${fx.cycle.id}`, { method: 'patch', data: { parcel_enabled: true, parcel_fee: 3.9 } })).status()).toBe(200)
    const product = await admin('/api/products', {
      method: 'post', data: { cycle_id: fx.cycle.id, name: `WA3 Káva ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 10, price_1kg: 30 },
    })
    expect(product.status()).toBe(201)
    fx.product = await product.json()
    const line = (q = 1) => [{ product_id: fx.product.id, variant: '250g', quantity: q }]
    const location = async (label) => {
      const res = await admin('/api/pickup-locations', { method: 'post', data: { name: `WA3 ${label} ${uniq}`, address: `Ulica ${label}`, for_coffee: true, for_bakery: true } })
      expect(res.status()).toBe(201)
      return res.json()
    }
    fx.L = await location('L')
    fx.L2 = await location('L2')

    fx.A = await makeFriend('Alena', '0905 301 001') // will PAY ⇒ owes nothing
    fx.B = await makeFriend('Boris', '0905 301 002') // packed, unpaid ⇒ debtor
    fx.C = await makeFriend('Cyril', '0905 301 003') // back-dated to yesterday (§3)
    fx.O = await makeFriend('Olga', '0905 301 004') // opted OUT
    fx.P = await makeFriend('Pavol', '0905 301 005') // own Packeta
    fx.H = await makeFriend('Hana', '0905 301 006') // host at L2
    fx.N = await makeFriend('Norbert') // NO phone, empty auto-saved draft
    fx.D = await makeFriend('Dusan', '0905 301 008') // draft WITH an item, never submitted

    fx.oA = await ownOrder(fx.A, fx.cycle.id, line(), { pickup_location_id: fx.L.id })
    fx.oB = await ownOrder(fx.B, fx.cycle.id, line(), { pickup_location_id: fx.L.id })
    fx.oC = await ownOrder(fx.C, fx.cycle.id, line(), { pickup_location_id: fx.L.id })
    fx.oO = await ownOrder(fx.O, fx.cycle.id, line(), { pickup_location_id: fx.L.id })
    fx.oP = await ownOrder(fx.P, fx.cycle.id, line(), { use_parcel_delivery: true, packeta_address: `Z-BOX WA3 ${uniq}` })
    fx.oH = await ownOrder(fx.H, fx.cycle.id, line(), { pickup_location_id: fx.L2.id })
    await cart(fx.N, fx.cycle.id, [])
    await cart(fx.D, fx.cycle.id, line())

    const link = await ctx.post(`/api/guest-links/cycle/${fx.cycle.id}`, { headers: fx.H.auth, timeout: TIMEOUT })
    expect([200, 201]).toContain(link.status())
    fx.link = (await link.json()).link
    const guest = async (data) => {
      const res = await ctx.post(`/api/guest/${fx.link.token}/orders`, { data: { items: line(), ...data }, timeout: TIMEOUT })
      expect(res.status(), 'guest submit').toBe(201)
      return (await res.json()).order
    }
    fx.G1 = await guest({ guest_name: `Gabika${uniq} Hosťová`, guest_phone: '0911 301 001' })
    fx.G2 = await guest({ guest_name: `Gejza${uniq} Zrušený`, guest_phone: '0911 301 002' })
    fx.GP = await guest({
      guest_name: `Gustav${uniq} Packeta`, guest_phone: '0911 301 003', guest_email: `wa3.${uniq}@example.test`,
      use_parcel_delivery: true, packeta_address: `Z-BOX Hosť ${uniq}`,
    })

    expect((await admin(`/api/friends/${fx.O.id}`, { method: 'patch', data: { whatsapp_opt_in: false } })).status(), 'O opts out').toBe(200)

    for (const [f, o] of [[fx.A, fx.oA], [fx.B, fx.oB], [fx.C, fx.oC], [fx.O, fx.oO], [fx.P, fx.oP], [fx.H, fx.oH]]) {
      await packFriend(fx.cycle.id, f, o.id)
    }
    await packGuestParty(fx.cycle.id, fx.GP.id)
    expect((await admin(`/api/orders/${fx.oA.id}/paid`, { method: 'patch', data: { paid: true } })).status(), 'A pays').toBe(200)

    fx.stampA = await handOver(fx.oA.id)
    await handOver(fx.oB.id)
    fx.stampC = await handOver(fx.oC.id)
    await handOver(fx.oO.id)
    fx.stampP = await handOver(fx.oP.id)
    fx.stampH = await handOver(fx.oH.id) // stamps G1 AND G2 (both live at this point)
    fx.stampGP = await handOverGuest(fx.GP.id)
    fx.today = bratislavaDate(fx.stampA)
  })

  test('handed_over:pickup:<L>:<today> lists A and B (and C until §3 back-dates it); the opted-out O is absent and counted', async () => {
    expect(bratislavaDate(fx.stampC), 'fixture: all stamped today').toBe(fx.today)
    const s = await preview(fx.cycle.id, `handed_over:pickup:${fx.L.id}:${fx.today}`)
    expect(s.key).toBe(`handed_over:pickup:${fx.L.id}:${fx.today}`)
    expect(s.template_key).toBe('pickup')
    expect(s.name).toBe(`${fx.L.name} — odovzdané ${dm(fx.today)}`)
    expect(s.recipients.map((r) => r.recipient_id).sort((a, b) => a - b)).toEqual([fx.A.id, fx.B.id, fx.C.id].sort((a, b) => a - b))
    expect(rec(s, 'friend', fx.O.id), 'opted out ⇒ in no segment').toBeUndefined()
    expect(s.excluded_opt_out).toBe(1)
    expect(s.count).toBe(3)
    expect(s.opted_out, 'the in-process opted-out LIST never crosses the JSON boundary (names stay private)').toBeUndefined()
    // L2 holds the host; nobody of L2 leaks into L.
    expect(rec(s, 'friend', fx.H.id)).toBeUndefined()
    const l2 = await preview(fx.cycle.id, `handed_over:pickup:${fx.L2.id}:${fx.today}`)
    expect(l2.recipients.map((r) => r.recipient_id)).toEqual([fx.H.id])
  })

  test('vars over JSON: NOTHING_OWED ⇒ `suma: null` (key PRESENT), a debtor ⇒ the formatted ledger debt; {odkaz} never published, only `odkaz_resolved`', async () => {
    const s = await preview(fx.cycle.id, `handed_over:pickup:${fx.L.id}:${fx.today}`)
    const a = rec(s, 'friend', fx.A.id)
    const b = rec(s, 'friend', fx.B.id)
    expect(await owedOf(fx.A.id), 'fixture: A is settled').toBeLessThanOrEqual(0)
    const owedB = await owedOf(fx.B.id)
    expect(owedB, 'fixture: B owes the packed order').toBeGreaterThan(0)

    expect(Object.prototype.hasOwnProperty.call(a.vars, 'suma'), 'the key survives JSON (a raw Symbol would be dropped)').toBe(true)
    expect(a.vars.suma).toBe(null)
    expect(b.vars.suma).toBe(money(owedB))
    expect(a.vars).toEqual({
      meno: fx.A.first, 'objednávka': fx.cycle.name, miesto: `${fx.L.name} (Ulica L)`, suma: null, datum: 'v piatok 6. 11.',
    })
    expect(a).toMatchObject({
      recipient_kind: 'friend', recipient_id: fx.A.id, name: fx.A.name, phone: '0905 301 001', phone_e164: '+421905301001',
      opt_in: 1, order_id: fx.oA.id, guest_order_id: null, odkaz_resolved: true,
    })
  })

  test('handed_over:packeta:<today> merges the friend P and the own-Packeta guest GP; guest {suma} = total + fee; no order_token anywhere in the JSON', async () => {
    expect(bratislavaDate(fx.stampP)).toBe(fx.today)
    const res = await admin('/api/notifications/segments', { params: { cycle_id: String(fx.cycle.id), segment_key: `handed_over:packeta:${fx.today}` } })
    const raw = await res.text()
    const s = JSON.parse(raw).segment
    expect(s.template_key).toBe('packeta')
    expect(s.name).toBe(`Packeta — odovzdané ${dm(fx.today)}`)
    expect(s.recipients.map((r) => `${r.recipient_kind}:${r.recipient_id}`).sort()).toEqual([`friend:${fx.P.id}`, `guest:${fx.GP.id}`].sort())
    const gp = rec(s, 'guest', fx.GP.id)
    expect(gp).toMatchObject({ name: fx.GP.guest_name, guest_order_id: fx.GP.id, order_id: null, opt_in: null, odkaz_resolved: true })
    expect(gp.vars.suma).toBe(money(fx.GP.total + 3.9))
    expect(gp.vars.miesto).toBe(`Z-BOX Hosť ${uniq}`)
    expect(gp.vars.host).toBe(fx.H.first)
    expect(fx.GP.order_token, 'non-vacuity: the guest HAS a token').toBeTruthy()
    expect(raw, 'the preview never publishes a guest credential').not.toContain(fx.GP.order_token)
  })

  test('host_guests:<H>:<today> — a sub-order CANCELLED after the hand-over (it keeps its stamp) leaves the group; the Packeta guest is never in it', async () => {
    const key = `host_guests:${fx.H.id}:${bratislavaDate(fx.stampH)}`
    const before = await preview(fx.cycle.id, key)
    expect(before.template_key).toBe('host')
    expect(before.name).toBe(`Hostia ${fx.H.first} — odovzdané hostiteľovi`)
    expect(before.recipients.map((r) => r.recipient_id).sort((a, b) => a - b), 'non-vacuity: G2 is in the group while live')
      .toEqual([fx.G1.id, fx.G2.id].sort((a, b) => a - b))
    expect(rec(before, 'guest', fx.G1.id).vars.suma).toBe(money(fx.G1.total))
    expect(rec(before, 'guest', fx.G1.id).vars.host).toBe(fx.H.first)

    expect((await admin(`/api/guest-orders/${fx.G2.id}/cancel`, { method: 'post' })).status(), 'admin cancels G2').toBe(200)
    const after = await preview(fx.cycle.id, key)
    expect(after.recipients.map((r) => r.recipient_id)).toEqual([fx.G1.id])
    expect(rec(after, 'guest', fx.GP.id)).toBeUndefined()
  })

  test('not_ordered: the empty auto-saved draft (N, no phone ⇒ `no_phone`) is in, the draft with an item (D) is not; opting out moves a friend into `excluded_opt_out`', async () => {
    const key = `not_ordered:${fx.cycle.id}`
    const s = await preview(fx.cycle.id, key)
    expect(s.template_key).toBe('closing')
    expect(s.name).toBe('Neobjednali (otvorená objednávka)')
    const n = rec(s, 'friend', fx.N.id)
    expect(n, 'empty auto-saved order counts as NOT ordered').toBeTruthy()
    expect(n.phone_e164).toBe(null)
    expect(n.vars.suma, 'nothing owed').toBe(null)
    expect(n.vars.datum).toBe('v piatok 6. 11.')
    expect(rec(s, 'friend', fx.D.id), 'a row with ≥ 1 item counts as ordered (21 §UC-WA-005 literal)').toBeUndefined()
    expect(rec(s, 'friend', fx.A.id)).toBeUndefined()
    expect(s.no_phone).toBe(s.recipients.filter((r) => r.phone_e164 === null).length)
    expect(s.no_phone).toBeGreaterThanOrEqual(1)

    const computedBefore = (await segments(fx.cycle.id)).computed.find((c) => c.key === key)
    expect(computedBefore.count).toBe(s.count)
    expect((await admin(`/api/friends/${fx.N.id}`, { method: 'patch', data: { whatsapp_opt_in: false } })).status()).toBe(200)
    const after = await preview(fx.cycle.id, key)
    expect(rec(after, 'friend', fx.N.id), 'opted out ⇒ in none').toBeUndefined()
    expect(after.excluded_opt_out).toBe(s.excluded_opt_out + 1)
    expect(after.count).toBe(s.count - 1)
    const all = await preview(fx.cycle.id, 'all_active')
    expect(rec(all, 'friend', fx.N.id)).toBeUndefined()
    expect(rec(all, 'friend', fx.O.id)).toBeUndefined()
    expect(rec(all, 'friend', fx.A.id)).toBeTruthy()
    expect(all.template_key).toBe('custom')
    expect((await admin(`/api/friends/${fx.N.id}`, { method: 'patch', data: { whatsapp_opt_in: true } })).status(), 'restore').toBe(200)
  })

  test('GET /segments: `computed` = not_ordered / waitlist / all_active with counts + template_enabled (mirrors the template row); `groups` = the outbox rows the hand-overs queued', async () => {
    const body = await segments(fx.cycle.id)
    expect(body.cycle).toEqual({ id: fx.cycle.id, name: fx.cycle.name, status: 'open' })
    expect(body.segment, 'no segment_key ⇒ no preview').toBeUndefined()
    expect(body.computed.map((c) => c.key)).toEqual([`not_ordered:${fx.cycle.id}`, `waitlist:${fx.cycle.id}`, 'all_active'])
    const templates = Object.fromEntries((await (await admin('/api/notifications/templates')).json()).templates.map((t) => [t.key, t.enabled]))
    for (const c of body.computed) {
      expect(c.template_enabled).toBe(templates[c.template_key])
      for (const k of ['count', 'excluded_opt_out', 'no_phone']) expect(Number.isInteger(c[k]), `${c.key}.${k}`).toBe(true)
    }

    // The groups are the outbox rows the hand-overs queued (DP-T3's hook). Their KEYS are
    // DP-T3's (`loc<id>` / `packeta` / `host:<id>`) until WA-T4 moves the hook onto 21's
    // grammar — so a key outside the grammar has `name: null` and its rows are not
    // readable through the validated rows route (400). Both branches are asserted, so
    // the test holds before AND after WA-T4.
    const pickupGroups = body.groups.filter((g) => g.template_key === 'pickup')
    expect(pickupGroups.length, 'the hand-overs queued pickup rows').toBeGreaterThan(0)
    expect(pickupGroups.reduce((n, g) => n + g.counts.queued, 0), 'A, B, C (+ H, O) queued').toBeGreaterThanOrEqual(3)
    for (const g of body.groups) {
      expect(Object.keys(g).sort()).toEqual(['counts', 'name', 'segment_key', 'template_key', 'template_name', 'total'])
      expect(Object.keys(g.counts).sort()).toEqual(['failed', 'queued', 'released', 'sent', 'skipped'])
      expect(Object.values(g.counts).reduce((a, b) => a + b, 0)).toBe(g.total)
      const rows = await admin('/api/notifications', { params: { cycle_id: String(fx.cycle.id), segment_key: g.segment_key } })
      if (/^[a-z_]+(:[A-Za-z0-9-]+)*$/.test(g.segment_key)) {
        expect(rows.status(), g.segment_key).toBe(200)
        const list = (await rows.json()).rows
        expect(list.filter((r) => r.template_key === g.template_key).length, 'counts agree with the rows').toBe(g.total)
      } else {
        expect(g.name, `${g.segment_key} is outside 21's grammar ⇒ no title`).toBe(null)
        expect(rows.status(), `${g.segment_key} ⇒ 400 on the validated rows route`).toBe(400)
      }
    }
    const pickupTemplate = body.groups.find((g) => g.template_key === 'pickup')
    expect(pickupTemplate.template_name).toBe('Doručené na odberné miesto')
  })

  // ── §3 DB_PATH: the rows route over a 21-grammar group ─────────────────────
  // ⚠ No writer of 21-grammar rows exists before WA-T4/WA-T5, so the group is written
  // here — every status, all three recipient tables — the way a later row will.
  test('§3 · GET /notifications: the rows of one group, `name`/`phone` from each recipient table, the listed fields only; GET /segments counts them per status', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const key = `handed_over:pickup:${fx.L.id}:${fx.today}`
    const db = new DatabaseSync(DB_PATH)
    const ids = []
    let waitId = null
    try {
      waitId = Number(db.prepare(
        'INSERT INTO guest_waitlist (host_friend_id, cycle_id, name, phone, phone_e164, whatsapp_opt_in) VALUES (?, ?, ?, ?, ?, 1)',
      ).run(fx.H.id, fx.cycle.id, `Wiktor${uniq} Rad`, '0912 301 099', null).lastInsertRowid)
      const ins = db.prepare(`
        INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, recipient_id, phone_e164, body, status,
                                   cycle_id, order_id, guest_order_id, sent_via, error, released_at, sent_at)
        VALUES (?, 'pickup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      ids.push(Number(ins.run('whatsapp', key, 'friend', fx.A.id, '+421905301001', 'Ahoj A', 'sent', fx.cycle.id, fx.oA.id, null, 'bot', null, '2026-10-24 10:00:00', '2026-10-24 10:00:05').lastInsertRowid))
      ids.push(Number(ins.run('whatsapp', key, 'guest', fx.G1.id, '+421911301001', 'Ahoj G', 'failed', fx.cycle.id, null, fx.G1.id, null, 'not_on_whatsapp', '2026-10-24 10:00:00', null).lastInsertRowid))
      ids.push(Number(ins.run('email', key, 'friend', fx.D.id, null, 'Ahoj D', 'queued', fx.cycle.id, null, null, null, null, null, null).lastInsertRowid))
      ids.push(Number(ins.run('whatsapp', key, 'waitlist', waitId, null, 'Ahoj W', 'skipped', fx.cycle.id, null, null, null, 'no_phone', null, null).lastInsertRowid))
    } finally {
      db.close()
    }
    try {
      const group = (await segments(fx.cycle.id)).groups.find((g) => g.segment_key === key)
      expect(group).toEqual({
        segment_key: key, name: `${fx.L.name} — odovzdané ${dm(fx.today)}`, template_key: 'pickup',
        template_name: 'Doručené na odberné miesto', counts: { queued: 1, released: 0, sent: 1, failed: 1, skipped: 1 }, total: 4,
      })
      const res = await admin('/api/notifications', { params: { cycle_id: String(fx.cycle.id), segment_key: key } })
      expect(res.status()).toBe(200)
      const raw = await res.text()
      const { rows } = JSON.parse(raw)
      expect(rows.map((r) => r.id)).toEqual(ids)
      for (const r of rows) {
        expect(Object.keys(r).sort()).toEqual([
          'body', 'channel', 'created_at', 'error', 'id', 'name', 'phone', 'phone_e164', 'recipient_id', 'recipient_kind',
          'released_at', 'sent_at', 'sent_via', 'status', 'template_key',
        ])
      }
      expect(rows[0]).toMatchObject({ recipient_kind: 'friend', name: fx.A.name, phone: '0905 301 001', status: 'sent', sent_via: 'bot', body: 'Ahoj A' })
      expect(rows[1]).toMatchObject({ recipient_kind: 'guest', name: fx.G1.guest_name, phone: '0911 301 001', status: 'failed', error: 'not_on_whatsapp' })
      expect(rows[2]).toMatchObject({ recipient_kind: 'friend', name: fx.D.name, phone: '0905 301 008', channel: 'email', status: 'queued' })
      expect(rows[3]).toMatchObject({ recipient_kind: 'waitlist', name: `Wiktor${uniq} Rad`, phone: '0912 301 099', status: 'skipped', phone_e164: null })
      expect(raw, 'no order_token field or value').not.toContain(fx.G1.order_token)
      // Another cycle's view never shows this group.
      const other = await admin('/api/cycles', { method: 'post', data: { name: `E2E WA3 other ${uniq}`, type: 'coffee', status: 'open' } })
      const otherId = (await other.json()).id
      expect((await segments(otherId)).groups.find((g) => g.segment_key === key)).toBeUndefined()
    } finally {
      const w = new DatabaseSync(DB_PATH)
      try {
        for (const id of ids) w.prepare('DELETE FROM notifications WHERE id = ?').run(id)
        if (waitId) w.prepare('DELETE FROM guest_waitlist WHERE id = ?').run(waitId)
      } finally {
        w.close()
      }
    }
  })

  test('GET /notifications for a group with no rows is an empty list, not an error', async () => {
    const res = await admin('/api/notifications', { params: { cycle_id: String(fx.cycle.id), segment_key: 'all_active' } })
    expect(res.status()).toBe(200)
    expect(Array.isArray((await res.json()).rows)).toBe(true)
  })

  // ── §3 DB_PATH: „handed over yesterday" ─────────────────────────────────────
  test('§3 · two friends handed over at one point today + one yesterday ⇒ 2 and 1 (21 §UC-WA-005 acceptance)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = new DatabaseSync(DB_PATH)
    let stamp
    try {
      db.prepare("UPDATE orders SET handed_over_at = datetime(handed_over_at, '-1 day') WHERE id = ?").run(fx.oC.id)
      stamp = db.prepare('SELECT handed_over_at FROM orders WHERE id = ?').get(fx.oC.id).handed_over_at
    } finally {
      db.close()
    }
    const yesterday = bratislavaDate(stamp)
    expect(yesterday, 'non-vacuity: the back-date moved the Bratislava day').not.toBe(fx.today)
    const today = await preview(fx.cycle.id, `handed_over:pickup:${fx.L.id}:${fx.today}`)
    const yday = await preview(fx.cycle.id, `handed_over:pickup:${fx.L.id}:${yesterday}`)
    expect(today.recipients.map((r) => r.recipient_id).sort((a, b) => a - b)).toEqual([fx.A.id, fx.B.id].sort((a, b) => a - b))
    expect(yday.recipients.map((r) => r.recipient_id)).toEqual([fx.C.id])
    expect(yday.name).toBe(`${fx.L.name} — odovzdané ${dm(yesterday)}`)
  })

  // ── §3 DB_PATH: the waitlist segment over the served DB ─────────────────────
  test('§3 · waitlist:<cycle>: notified row absent, opt-in-0 absent + counted, no-phone returned + counted; standing token never in the JSON; an un-minted host stays un-minted', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const standing = await admin(`/api/friends/${fx.H.id}/guest-link/standing`)
    expect(standing.status(), 'admin mints H a standing link').toBe(200)
    const token = (await standing.json()).standing.token
    expect(token).toBeTruthy()
    const H2 = await makeFriend('Hugo', '0905 301 009') // never minted

    const db = new DatabaseSync(DB_PATH)
    const W = {}
    try {
      const ins = db.prepare(
        'INSERT INTO guest_waitlist (host_friend_id, cycle_id, name, phone, phone_e164, whatsapp_opt_in, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      W.w1 = Number(ins.run(fx.H.id, fx.cycle.id, `Waldo${uniq} Čaká`, '0912 301 001', '+421912301001', 1, null).lastInsertRowid)
      W.w2 = Number(ins.run(fx.H.id, fx.cycle.id, `Wanda${uniq} Upozornená`, '0912 301 002', '+421912301002', 1, '2026-10-20 10:00:00').lastInsertRowid)
      W.w3 = Number(ins.run(fx.H.id, fx.cycle.id, `Werner${uniq} Bezsúhlasu`, '0912 301 003', '+421912301003', 0, null).lastInsertRowid)
      W.w4 = Number(ins.run(fx.H.id, fx.cycle.id, `Wilma${uniq} Bezčísla`, '12', null, 1, null).lastInsertRowid)
      W.w5 = Number(ins.run(H2.id, fx.cycle.id, `Walter${uniq} Nemintnutý`, '0912 301 005', '+421912301005', 1, null).lastInsertRowid)
    } finally {
      db.close()
    }
    try {
      const key = `waitlist:${fx.cycle.id}`
      const before = (await segments(fx.cycle.id)).computed.find((c) => c.key === key)
      const res = await admin('/api/notifications/segments', { params: { cycle_id: String(fx.cycle.id), segment_key: key } })
      expect(res.status()).toBe(200)
      const raw = await res.text()
      const s = JSON.parse(raw).segment
      expect(s.template_key).toBe('waitlist')
      expect(s.name).toBe('Čakajúci hostia')
      expect(rec(s, 'waitlist', W.w1)).toMatchObject({ name: `Waldo${uniq} Čaká`, opt_in: 1, odkaz_resolved: true })
      expect(rec(s, 'waitlist', W.w1).vars).toEqual({ meno: `Waldo${uniq}`, host: fx.H.first, 'objednávka': fx.cycle.name, datum: 'v piatok 6. 11.' })
      expect(rec(s, 'waitlist', W.w2), 'notified ⇒ absent').toBeUndefined()
      expect(rec(s, 'waitlist', W.w3), 'no consent ⇒ absent').toBeUndefined()
      expect(rec(s, 'waitlist', W.w4).phone_e164, 'no number ⇒ RETURNED').toBe(null)
      expect(rec(s, 'waitlist', W.w5).odkaz_resolved, 'un-minted host ⇒ {odkaz} unresolved').toBe(false)
      expect(raw, 'the standing token never crosses this route').not.toContain(token)
      expect(s.count).toBe(before.count)
      expect(s.excluded_opt_out).toBeGreaterThanOrEqual(1)
      expect(s.no_phone).toBe(s.recipients.filter((r) => r.phone_e164 === null).length)

      const ro = new DatabaseSync(DB_PATH, { readOnly: true })
      try {
        expect(ro.prepare('SELECT guest_link_token FROM friends WHERE id = ?').get(H2.id).guest_link_token, 'a read never mints').toBe(null)
      } finally {
        ro.close()
      }
    } finally {
      for (const id of Object.values(W)) await admin(`/api/guest-waitlist/${id}`, { method: 'delete' })
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Validation — unbindable / malformed query ⇒ 400, unknown cycle / segment ⇒ 404
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T3 · query validation of the two read routes', () => {
  let cycleId = null
  test.beforeAll(async () => {
    const res = await admin('/api/cycles', { method: 'post', data: { name: `E2E WA3 val ${uniq}`, type: 'coffee', status: 'open' } })
    expect(res.status()).toBe(201)
    cycleId = (await res.json()).id
  })

  const raw = (path) => ctx.get(path, { headers: { 'X-Admin-Token': adminToken }, timeout: TIMEOUT })

  test('cycle_id: missing / non-integer / zero / negative / float / repeated ⇒ 400 `invalid_cycle_id`; unknown ⇒ 404 `unknown_cycle`', async () => {
    for (const base of ['/api/notifications/segments', '/api/notifications']) {
      const sk = base.endsWith('segments') ? '' : '&segment_key=all_active'
      for (const q of ['', '?cycle_id=', '?cycle_id=abc', '?cycle_id=0', '?cycle_id=-1', '?cycle_id=1.5', '?cycle_id=1&cycle_id=2', '?cycle_id[a]=1', '?cycle_id=99999999999999999']) {
        const res = await raw(`${base}${q}${q ? sk : sk.replace('&', '?')}`)
        expect(res.status(), `${base}${q}`).toBe(400)
        expect((await res.json()).reason).toBe('invalid_cycle_id')
      }
      const missing = await raw(`${base}?cycle_id=999999999${sk}`)
      expect(missing.status()).toBe(404)
      expect((await missing.json()).reason).toBe('unknown_cycle')
    }
  })

  test('segment_key: required on the rows route; ungrammatical / > 80 / repeated ⇒ 400 `invalid_segment_key`', async () => {
    const res = await raw(`/api/notifications?cycle_id=${cycleId}`)
    expect(res.status()).toBe(400)
    expect((await res.json()).reason).toBe('invalid_segment_key')
    for (const base of ['/api/notifications/segments', '/api/notifications']) {
      for (const k of ['Bad%20Key', 'a::b', 'x:', 'x'.repeat(81), 'x%3Ay%3Bz', '', 'all_active&segment_key=all_active']) {
        const r = await raw(`${base}?cycle_id=${cycleId}&segment_key=${k}`)
        expect(r.status(), `${base} ${k}`).toBe(400)
        expect((await r.json()).reason).toBe('invalid_segment_key')
      }
    }
  })

  test('preview: a grammatical key that is no segment ⇒ 404 `unknown_segment`; a key naming ANOTHER cycle ⇒ 400 `segment_cycle_mismatch`', async () => {
    for (const k of ['host:7', 'packeta', 'nonsense:1', 'handed_over:pickup:abc:2026-10-24', 'handed_over:pickup:3:2026-02-31', 'not_ordered']) {
      const r = await raw(`/api/notifications/segments?cycle_id=${cycleId}&segment_key=${k}`)
      expect(r.status(), k).toBe(404)
      expect((await r.json()).reason).toBe('unknown_segment')
    }
    for (const k of [`not_ordered:${cycleId + 1}`, `waitlist:${cycleId + 1}`]) {
      const r = await raw(`/api/notifications/segments?cycle_id=${cycleId}&segment_key=${k}`)
      expect(r.status(), k).toBe(400)
      expect((await r.json()).reason).toBe('segment_cycle_mismatch')
    }
    // ⚠ DP-T3's `loc<id>` key is outside the grammar: 400 on BOTH routes (the seam WA-T4
    // closes by moving the hook onto 21's keys). A grammatical non-segment key is
    // readable on the rows route (an empty group is `[]`).
    for (const base of ['/api/notifications/segments', '/api/notifications']) {
      const legacy = await raw(`${base}?cycle_id=${cycleId}&segment_key=loc5`)
      expect(legacy.status(), base).toBe(400)
    }
    const host = await raw(`/api/notifications?cycle_id=${cycleId}&segment_key=host:7`)
    expect(host.status()).toBe(200)
    expect((await host.json()).rows).toEqual([])
  })

  test('the routes are admin-only (anonymous ⇒ 401) — the full sweep is api-security.spec.js', async () => {
    for (const p of [`/api/notifications/segments?cycle_id=${cycleId}`, `/api/notifications?cycle_id=${cycleId}&segment_key=all_active`]) {
      expect((await ctx.get(p, { timeout: TIMEOUT })).status(), p).toBe(401)
    }
  })
})
