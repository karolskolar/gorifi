// Module 21 — WA-T2: 21 §UC-WA-004 (templates in `settings`, the closed placeholder
// vocabulary, ONE pure `renderTemplate()`, the formatters) as amended by the „PO
// decisions 2026-09-19" section — `{suma}` for friends = the LEDGER balance, for guests
// = the sub-order amount incl. fee, and the ORCHESTRATOR CLARIFICATION: when nothing
// is owed the renderer DROPS the whole sentence holding `{suma}`. D4's „už uhradené"
// substitution is RETIRED, so §UC-WA-004's acceptance line about it is superseded —
// the drop is what is pinned here, on the three enabled seeds.
//
// FOUR KINDS OF EVIDENCE, each where only it can work:
//   §1 PURE — `backend/src/helpers/template-render.js` imported with plain node (this
//      repo's substitute for a unit test, the `lib/cycle-stages.js` idiom): the seed
//      table, the vocabulary, `renderTemplate`, the formatters.
//   §2 THROWAWAY BOOTS — a child `node` imports `db/schema.js` + `helpers/templates.js`
//      against a temp file (the `whatsapp-schema.spec.js` idiom): the boot seed, „never
//      overwrites", and the fail-quiet reader on every invalid row shape.
//   §3 HTTP — `GET/PUT /api/notifications/templates(/:key)` on the gate server.
//   §4 DB_PATH-gated HTTP — a hand-corrupted row on the SERVED database still 200s.
//
// ⚠ The expected seed below is TYPED FROM THE SPEC TABLE, never imported from the
// module — importing it would make the byte-exact check a tautology.

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'
import { BANNED } from '../helpers/vocabulary.js'
import { stripComments } from '../helpers/source-pins.js'

const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src')
const HAS_BACKEND_SRC = existsSync(join(BACKEND_SRC, 'db', 'schema.js'))
const NEEDS_BACKEND_SRC = 'needs the backend source beside e2e/ (skipped against a deployment)'
const srcUrl = (rel) => pathToFileURL(join(BACKEND_SRC, rel)).href

// ═════════════════════════════════════════════════════════════════════════════
// 21 §UC-WA-004's seed table, VERBATIM (D2: pickup/packeta/host on, closing/waitlist
// off; D3: custom on with an empty body; D10: no `{tracking}` in packeta).
// ═════════════════════════════════════════════════════════════════════════════
const KEYS = ['pickup', 'packeta', 'host', 'closing', 'waitlist', 'custom']
const SEED = {
  pickup: {
    name: 'Doručené na odberné miesto',
    enabled: true,
    body: 'Ahoj {meno}, vaša káva z Podpultovky je na odbernom mieste {miesto}. Môžete si ju vyzdvihnúť. Suma na úhradu: {suma}. Ďakujeme!',
  },
  packeta: {
    name: 'Odovzdané Packete',
    enabled: true,
    body: 'Ahoj {meno}, váš balík z Podpultovky sme odovzdali Packete ({miesto}). Packeta vám pošle správu, keď bude pripravený na výdaj. Suma na úhradu: {suma}.',
  },
  host: {
    name: 'Odovzdané priateľovi',
    enabled: true,
    body: 'Ahoj {meno}, vaša objednávka z Podpultovky je pripravená — má ju pri sebe {host}. Prevzatie si dohodnite priamo. Suma na úhradu: {suma}.',
  },
  closing: {
    name: 'Objednávky sa čoskoro zatvárajú',
    enabled: false,
    body: 'Ahoj {meno}, objednávka kávy z Podpultovky sa zatvára {datum}. Ak chcete, ešte stihnete objednať: {odkaz}',
  },
  waitlist: {
    name: 'Objednávka otvorená (čakajúci hostia)',
    enabled: false,
    body: 'Ahoj {meno}, {host} vám otvoril objednávku kávy z Podpultovky. Objednávajte tu: {odkaz}',
  },
  custom: { name: 'Vlastná správa', enabled: true, body: '' },
}
const VOCABULARY = ['{meno}', '{objednávka}', '{miesto}', '{suma}', '{odkaz}', '{host}', '{datum}', '{tracking}']
const seedJson = (key) => ({ name: SEED[key].name, body: SEED[key].body, enabled: SEED[key].enabled ? 1 : 0 })
const seedTemplate = (key) => ({ key, ...SEED[key] })

// ═════════════════════════════════════════════════════════════════════════════
// §1 PURE — the module a later row (WA-T3 segments, WA-T4 release) builds on
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T2 · 21 §UC-WA-004 — the pure module (plain-node import)', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)
  let tr
  test.beforeAll(async () => { tr = await import(srcUrl('helpers/template-render.js')) })

  test('the seed table is 21 §UC-WA-004 byte for byte, in key order; the vocabulary is closed at eight', () => {
    expect(tr.TEMPLATE_KEYS).toEqual(KEYS)
    expect(Object.keys(tr.TEMPLATE_SEEDS)).toEqual(KEYS)
    for (const key of KEYS) {
      expect(tr.TEMPLATE_SEEDS[key], key).toEqual({ name: SEED[key].name, body: SEED[key].body, enabled: SEED[key].enabled ? 1 : 0 })
    }
    expect(tr.PLACEHOLDERS).toEqual(VOCABULARY)
    expect(tr.templateSettingKey('pickup')).toBe('wa_template:pickup')
    expect(tr.TEMPLATE_SEEDS.packeta.body, 'D10: {tracking} is NOT in the packeta seed').not.toContain('{tracking}')
  })

  test('the seeds speak the „objednávka" register: no „kolo"/„cyklus" in any name or body (the ONE banned regex), no `{kolo}`', () => {
    const strings = KEYS.flatMap((k) => [tr.TEMPLATE_SEEDS[k].name, tr.TEMPLATE_SEEDS[k].body])
    expect(strings.join(' ').length, 'non-vacuity').toBeGreaterThan(400)
    expect(strings.filter((s) => BANNED.test(s))).toEqual([])
    expect(BANNED.test('Ahoj {meno}, kolo sa zatvára'), 'non-vacuity: the regex does fire').toBe(true)
    expect(strings.join(' ')).not.toContain('{kolo}')
    expect(tr.PLACEHOLDERS).not.toContain('{kolo}')
  })

  test('unknownPlaceholders(): every `{…}` token outside the vocabulary, in order; `{objednávka}` (incl. its NFD spelling) is known', () => {
    expect(tr.unknownPlaceholders('Ahoj {meno}')).toEqual([])
    expect(tr.unknownPlaceholders('Ahoj {menoo}, {suma} {kolo}')).toEqual(['{menoo}', '{kolo}'])
    expect(tr.unknownPlaceholders('{objednávka}')).toEqual([])
    expect(tr.unknownPlaceholders('{objednávka}'.normalize('NFD'))).toEqual([])
    expect(tr.unknownPlaceholders('{objednavka}'), 'the ASCII spelling is NOT the placeholder').toEqual(['{objednavka}'])
    expect(tr.unknownPlaceholders('{}  { meno }  {Meno}')).toEqual(['{}', '{ meno }', '{Meno}'])
    expect(tr.unknownPlaceholders('a stray { brace'), 'an unpaired brace is not a token').toEqual([])
    expect(tr.unknownPlaceholders('a stray } brace :)')).toEqual([])
    expect(tr.unknownPlaceholders('{ any text in braces }'), 'a brace PAIR is a token, whatever it holds').toEqual(['{ any text in braces }'])
    for (const p of VOCABULARY) expect(tr.unknownPlaceholders(`x ${p} y`), p).toEqual([])
  })

  test('renderTemplate: every known placeholder with a value is replaced, `{objednávka}` included; values are never re-scanned', () => {
    const body = '{meno}|{objednávka}|{miesto}|{suma}|{odkaz}|{host}|{datum}|{tracking}'
    const vars = {
      meno: 'Karol', 'objednávka': 'Október 2026', miesto: 'Kaviareň (Hlavná 1)', suma: '31,10 €',
      odkaz: 'https://podpultovka.biz', host: 'Lego', datum: 'v piatok 11. 9.', tracking: 'Z123',
    }
    expect(tr.renderTemplate(body, vars)).toBe('Karol|Október 2026|Kaviareň (Hlavná 1)|31,10 €|https://podpultovka.biz|Lego|v piatok 11. 9.|Z123')
    // NFD-typed token in the body still resolves.
    expect(tr.renderTemplate('{objednávka}'.normalize('NFD'), vars)).toBe('Október 2026')
    // A value that LOOKS like a placeholder is inserted, not expanded again.
    expect(tr.renderTemplate('{meno} / {host}', { meno: '{host}', host: 'Lego' })).toBe('{host} / Lego')
  })

  test('D10: a placeholder with NO value stays LITERAL — undefined, null, \'\', blank, a non-string; `{tracking}` always; unknown tokens untouched', () => {
    const closing = SEED.closing.body
    expect(tr.renderTemplate(closing, { meno: 'Karol', odkaz: 'https://podpultovka.biz' }))
      .toBe('Ahoj Karol, objednávka kávy z Podpultovky sa zatvára {datum}. Ak chcete, ešte stihnete objednať: https://podpultovka.biz')
    for (const datum of [undefined, null, '', '   ', {}, ['v piatok'], true, Number.NaN]) {
      expect(tr.renderTemplate('do {datum}', { datum }), String(datum)).toBe('do {datum}')
    }
    expect(tr.renderTemplate('Sledovanie: {tracking}', { meno: 'Karol' })).toBe('Sledovanie: {tracking}')
    expect(tr.renderTemplate('{menoo} {meno}', { meno: 'Karol', menoo: 'X' })).toBe('{menoo} Karol')
    expect(tr.renderTemplate('Ahoj {meno}')).toBe('Ahoj {meno}')
    expect(tr.renderTemplate(null, { meno: 'x' })).toBe('')
    // A `{suma}` with no value at all (not the marker) is literal too — it is what blocks release.
    expect(tr.renderTemplate(SEED.pickup.body, { meno: 'Karol', miesto: 'Kaviareň' }))
      .toBe('Ahoj Karol, vaša káva z Podpultovky je na odbernom mieste Kaviareň. Môžete si ju vyzdvihnúť. Suma na úhradu: {suma}. Ďakujeme!')
    expect(tr.unresolvedFor('Suma: {suma}. {datum} {menoo}', {})).toEqual(['{suma}', '{datum}'])
    expect(tr.unresolvedFor('Ahoj {meno}.', { meno: 'Karol' })).toEqual([])
    expect(tr.unresolvedFor(SEED.closing.body, { meno: 'K', odkaz: 'https://podpultovka.biz' })).toEqual(['{datum}'])
    expect(tr.unresolvedFor(SEED.pickup.body, { meno: 'K', miesto: 'M', suma: tr.NOTHING_OWED }), 'a dropped {suma} is not unresolved').toEqual([])
    expect(tr.unresolvedFor(SEED.pickup.body, { meno: 'K', miesto: 'M', suma: Number.NaN })).toEqual(['{suma}'])
  })

  test('⚠ unresolvedFor() answers from TEMPLATE + VARS — braces arriving through a VALUE neither block nor pass a row; the rescan export is gone', () => {
    const vars = { meno: '{suma}', miesto: '{datum} {tracking}', suma: '4,20 €' }
    const rendered = tr.renderTemplate(SEED.pickup.body, vars)
    expect(rendered, 'non-vacuity: the value-borne braces really are in the text')
      .toBe('Ahoj {suma}, vaša káva z Podpultovky je na odbernom mieste {datum} {tracking}. Môžete si ju vyzdvihnúť. Suma na úhradu: 4,20 €. Ďakujeme!')
    expect(tr.unresolvedFor(SEED.pickup.body, vars)).toEqual([])
    // …and the converse: a value cannot hide a placeholder the template left unresolved.
    expect(tr.unresolvedFor(SEED.pickup.body, { meno: 'K', miesto: 'M' })).toEqual(['{suma}'])
    expect(tr.unresolvedPlaceholders, 'a rescan of the rendered body is not offered').toBeUndefined()
  })

  test('PO 2026-09-19 + orchestrator: NOTHING_OWED drops the whole `{suma}` sentence on all three enabled seeds — exact strings', () => {
    expect(typeof tr.NOTHING_OWED, 'an explicit marker, distinct from every string').toBe('symbol')
    const v = { meno: 'Karol', miesto: 'Nám. SNP 1, Bratislava', host: 'Lego', suma: tr.NOTHING_OWED }
    expect(tr.renderTemplate(SEED.pickup.body, v))
      .toBe('Ahoj Karol, vaša káva z Podpultovky je na odbernom mieste Nám. SNP 1, Bratislava. Môžete si ju vyzdvihnúť. Ďakujeme!')
    expect(tr.renderTemplate(SEED.packeta.body, { ...v, miesto: 'Z-BOX Hlavná 1' }))
      .toBe('Ahoj Karol, váš balík z Podpultovky sme odovzdali Packete (Z-BOX Hlavná 1). Packeta vám pošle správu, keď bude pripravený na výdaj.')
    expect(tr.renderTemplate(SEED.host.body, v))
      .toBe('Ahoj Karol, vaša objednávka z Podpultovky je pripravená — má ju pri sebe Lego. Prevzatie si dohodnite priamo.')
    // …and the same seeds WITH an amount owed keep the sentence.
    expect(tr.renderTemplate(SEED.pickup.body, { ...v, suma: tr.formatMoney(31.1) }))
      .toBe('Ahoj Karol, vaša káva z Podpultovky je na odbernom mieste Nám. SNP 1, Bratislava. Môžete si ju vyzdvihnúť. Suma na úhradu: 31,10 €. Ďakujeme!')
    expect(tr.renderTemplate(SEED.host.body, { ...v, suma: '4,20 €' }))
      .toBe('Ahoj Karol, vaša objednávka z Podpultovky je pripravená — má ju pri sebe Lego. Prevzatie si dohodnite priamo. Suma na úhradu: 4,20 €.')
    // The marker is honoured for `{suma}` ONLY; anywhere else it is „no value" ⇒ literal.
    expect(tr.renderTemplate('Ahoj {meno}. Koniec.', { meno: tr.NOTHING_OWED })).toBe('Ahoj {meno}. Koniec.')
    // A body with no `{suma}` is untouched by the marker.
    expect(tr.renderTemplate(SEED.closing.body, { suma: tr.NOTHING_OWED, meno: 'K' })).toContain('Ahoj K, objednávka')
  })

  test('⚠ a NUMBER passed as `suma` goes through sumaValue(): `31.1` ⇒ `31,10 €`, `0`/negative ⇒ the sentence drops, NaN ⇒ literal — never a raw `31.1`/`0`', () => {
    const v = { meno: 'Karol', host: 'Lego' }
    expect(tr.renderTemplate(SEED.host.body, { ...v, suma: 31.1 }))
      .toBe('Ahoj Karol, vaša objednávka z Podpultovky je pripravená — má ju pri sebe Lego. Prevzatie si dohodnite priamo. Suma na úhradu: 31,10 €.')
    const dropped = 'Ahoj Karol, vaša objednávka z Podpultovky je pripravená — má ju pri sebe Lego. Prevzatie si dohodnite priamo.'
    expect(tr.renderTemplate(SEED.host.body, { ...v, suma: 0 })).toBe(dropped)
    expect(tr.renderTemplate(SEED.host.body, { ...v, suma: -12.5 })).toBe(dropped)
    expect(tr.renderTemplate(SEED.host.body, { ...v, suma: 0.004 }), 'rounds to 0 ⇒ nothing owed').toBe(dropped)
    expect(tr.renderTemplate('Suma: {suma}.', { suma: Number.NaN })).toBe('Suma: {suma}.')
    expect(tr.renderTemplate('Suma: {suma}.', { suma: 31.1 })).not.toContain('31.1')
  })

  test('the sentence drop at the edges: first sentence, `!`/`?` boundaries, its own line, no closing `.`, two occurrences', () => {
    const N = tr.NOTHING_OWED
    expect(tr.renderTemplate('Suma: {suma}. Ahoj.', { suma: N })).toBe('Ahoj.')
    expect(tr.renderTemplate('Ahoj! Suma {suma}? Ok.', { suma: N })).toBe('Ahoj! Ok.')
    expect(tr.renderTemplate('A.\nSuma: {suma}\nB.', { suma: N })).toBe('A.\nB.')
    expect(tr.renderTemplate('A.\nSuma: {suma}.\nB.', { suma: N })).toBe('A.\nB.')
    expect(tr.renderTemplate('Ahoj. Platba {suma}', { suma: N })).toBe('Ahoj.')
    expect(tr.renderTemplate('Platba {suma}', { suma: N })).toBe('')
    expect(tr.renderTemplate('A. Prvá {suma}. B. Druhá {suma}. C.', { suma: N })).toBe('A. B. C.')
    // Values substituted AFTER the drop, so a `.` inside a value cannot move a boundary.
    expect(tr.renderTemplate('Ahoj {meno}. Suma {suma}. Ďakujeme.', { meno: 'p. Novák', suma: N })).toBe('Ahoj p. Novák. Ďakujeme.')
  })

  test('⚠ a boundary is `.`/`!`/`?` FOLLOWED BY WHITESPACE OR THE END — decimals, URLs and mid-word dots never cut', () => {
    const N = tr.NOTHING_OWED
    expect(tr.renderTemplate('Platba 12.5 € alebo {suma}. Ok', { suma: N }), 'the decimal is inside the dropped sentence').toBe('Ok')
    expect(tr.renderTemplate('Ahoj. Zaplaťte cez revolut.me/karol, suma {suma}. Vďaka.', { suma: N })).toBe('Ahoj. Vďaka.')
    expect(tr.renderTemplate('Suma {suma} na revolut.me/karol. Vďaka.', { suma: N })).toBe('Vďaka.')
    expect(tr.renderTemplate('Viac na podpultovka.biz! Suma {suma}. Vďaka.', { suma: N })).toBe('Viac na podpultovka.biz! Vďaka.')
    expect(tr.renderTemplate('Ahoj.Suma {suma}. Vďaka.', { suma: N }), 'a dot with no space after is not a boundary').toBe('Vďaka.')
  })

  test('⚠ KNOWN LIMIT (documented in the module header): an abbreviation + space inside the TEMPLATE is a boundary, so the drop starts after it', () => {
    const N = tr.NOTHING_OWED
    expect(tr.renderTemplate('Ahoj. Suma (vr. dopravy): {suma}. Vďaka.', { suma: N })).toBe('Ahoj. Suma (vr. Vďaka.')
    // With an amount owed nothing is cut — the limit only bites when nothing is owed.
    expect(tr.renderTemplate('Ahoj. Suma (vr. dopravy): {suma}. Vďaka.', { suma: '5,00 €' })).toBe('Ahoj. Suma (vr. dopravy): 5,00 €. Vďaka.')
  })

  test('after a drop: 3+ line breaks collapse to 2, trailing whitespace is trimmed', () => {
    const N = tr.NOTHING_OWED
    expect(tr.renderTemplate('Ahoj!\n\nSuma: {suma}.\n\nĎakujeme!', { suma: N })).toBe('Ahoj!\n\nĎakujeme!')
    expect(tr.renderTemplate('Ahoj.\nSuma {suma}.', { suma: N })).toBe('Ahoj.')
    expect(tr.renderTemplate('Ahoj.\n\n\nSuma {suma}.\n', { suma: N })).toBe('Ahoj.')
    // Without a drop the template's own layout is untouched.
    expect(tr.renderTemplate('Ahoj!\n\n\n{meno}  ', { meno: 'K' })).toBe('Ahoj!\n\n\nK  ')
  })

  test('sumaValue(): a positive owed amount ⇒ `31,10 €`; ≤ 0 ⇒ NOTHING_OWED; not a finite number ⇒ \'\' (stays literal)', () => {
    expect(tr.sumaValue(31.1)).toBe('31,10 €')
    expect(tr.sumaValue(0.004), 'rounds to 0 ⇒ nothing owed').toBe(tr.NOTHING_OWED)
    expect(tr.sumaValue(0)).toBe(tr.NOTHING_OWED)
    expect(tr.sumaValue(-5)).toBe(tr.NOTHING_OWED)
    for (const bad of [undefined, null, '31.1', Number.NaN, Infinity, {}]) expect(tr.sumaValue(bad), String(bad)).toBe('')
  })

  test('formatMoney(): comma decimal, two places, an ORDINARY space before €', () => {
    expect(tr.formatMoney(31.1)).toBe('31,10 €')
    expect(tr.formatMoney(31.1)).not.toContain(' ')
    expect(tr.formatMoney(0)).toBe('0,00 €')
    expect(tr.formatMoney(26.189999999999998)).toBe('26,19 €')
    expect(tr.formatMoney(1234.5)).toBe('1234,50 €')
    for (const bad of [undefined, null, '31.1', Number.NaN, -Infinity]) expect(tr.formatMoney(bad), String(bad)).toBe('')
  })

  test('formatDatum(): `v piatok 12. 9.` — every weekday form (incl. „vo štvrtok"), no leading zeros; unparsable ⇒ \'\'', () => {
    expect(tr.formatDatum('2025-09-12')).toBe('v piatok 12. 9.')
    const week = {
      '2026-09-07': 'v pondelok 7. 9.',
      '2026-09-08': 'v utorok 8. 9.',
      '2026-09-09': 'v stredu 9. 9.',
      '2026-09-10': 'vo štvrtok 10. 9.',
      '2026-09-11': 'v piatok 11. 9.',
      '2026-09-12': 'v sobotu 12. 9.',
      '2026-09-13': 'v nedeľu 13. 9.',
    }
    for (const [iso, want] of Object.entries(week)) expect(tr.formatDatum(iso), iso).toBe(want)
    expect(tr.formatDatum('2026-12-31')).toBe('vo štvrtok 31. 12.')
    for (const bad of [null, undefined, '', '2026-02-31', '2026-9-1', '12. 9.', 20260912, {}]) {
      expect(tr.formatDatum(bad), String(bad)).toBe('')
    }
    // A Date instant is read as a Europe/Bratislava calendar day: 23:30Z on 11 Sep is
    // already 12 Sep (CEST, +2) in Bratislava, whatever the server's own TZ.
    expect(tr.formatDatum(new Date('2026-09-11T23:30:00Z'))).toBe('v sobotu 12. 9.')
    expect(tr.formatDatum(new Date('2026-09-11T21:30:00Z'))).toBe('v piatok 11. 9.')
    expect(tr.formatDatum(new Date(Number.NaN))).toBe('')
  })

  test('firstName(): `{meno}`/`{host}` = the first whitespace token, trimmed; non-strings ⇒ \'\'', () => {
    expect(tr.firstName('Karol Skolár')).toBe('Karol')
    expect(tr.firstName('  Ivet a Peto ')).toBe('Ivet')
    expect(tr.firstName('Lego')).toBe('Lego')
    expect(tr.firstName('Ján Novák'), 'NBSP is whitespace').toBe('Ján')
    expect(tr.firstName('Eva\tNová\n')).toBe('Eva')
    for (const bad of ['', '   ', null, undefined, 42, {}]) expect(tr.firstName(bad), String(bad)).toBe('')
  })

  test('the pure module stays pure: no DB, no Express, no route import (a spec imports it with plain node)', () => {
    const src = readFileSync(join(BACKEND_SRC, 'helpers', 'template-render.js'), 'utf8')
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l))
    expect(imports.join('\n')).not.toMatch(/schema\.js|better-sqlite3|express|routes\//)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Source pins — ONE home for the seed table and for the `wa_template:` settings writes
// ═════════════════════════════════════════════════════════════════════════════
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === 'uploads' ? [] : walk(p)
    return p.endsWith('.js') ? [p] : []
  })
}

test.describe('WA-T2 · 21 §UC-WA-004 — one home (source pins)', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('the seed copy lives in helpers/template-render.js only; the `wa_template:` key is composed there only', () => {
    const files = walk(BACKEND_SRC)
    expect(files.length, 'non-vacuity: the tree was walked').toBeGreaterThan(30)
    // CODE only — a comment may NAME a template (outbox.js maps keys to their names).
    const holding = (needle) => files.filter((f) => stripComments(readFileSync(f, 'utf8')).includes(needle)).map((f) => relative(BACKEND_SRC, f))
    // Readability gate: the strip did not eat the one file the positive pins need.
    const own = stripComments(readFileSync(join(BACKEND_SRC, 'helpers', 'template-render.js'), 'utf8'))
    for (const k of KEYS) expect(own, `the seed of ${k} survives the strip`).toContain(SEED[k].name)
    expect(holding('Doručené na odberné miesto')).toEqual(['helpers/template-render.js'])
    expect(holding('Môžete si ju vyzdvihnúť')).toEqual(['helpers/template-render.js'])
    expect(holding('`wa_template:${')).toEqual(['helpers/template-render.js'])
    expect(holding("'wa_template:"), 'no second spelling as a quoted literal').toEqual([])
    expect(holding('"wa_template:')).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 THROWAWAY BOOTS — the boot seed + the fail-quiet reader
// ═════════════════════════════════════════════════════════════════════════════
function probe(dbFile, body) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t2-probe-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    `import db from '${srcUrl('db/schema.js')}';\n` +
      `import * as templates from '${srcUrl('helpers/templates.js')}';\n` +
      `const logged = [];\n` +
      `const realError = console.error;\n` +
      `console.error = (...a) => { logged.push(a.join(' ')); };\n` +
      `const out = (() => {\n${body}\n})();\n` +
      `console.error = realError;\n` +
      `console.log('@@PROBE@@' + JSON.stringify({ out, logged }));\n`
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

const boot = (dbFile) => probe(dbFile, 'return true;')

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t2-db-'))
  try {
    return fn(join(dir, 'wa-t2.sqlite'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function templateRows(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return Object.fromEntries(
      db.prepare("SELECT key, value FROM settings WHERE key LIKE 'wa\\_template:%' ESCAPE '\\' ORDER BY key").all().map((r) => [r.key, r.value])
    )
  } finally {
    db.close()
  }
}

function setRow(file, key, value) {
  const db = new DatabaseSync(file)
  try {
    if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    else db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  } finally {
    db.close()
  }
}

test.describe('WA-T2 · 21 §UC-WA-001/004 — the boot seed and the fail-quiet reader (throwaway boots)', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('a FRESH boot seeds exactly the six `wa_template:*` rows, JSON `{name, body, enabled: 0|1}`, byte-exact to the spec', () => {
    withTempDb((file) => {
      boot(file)
      const rows = templateRows(file)
      expect(Object.keys(rows).sort()).toEqual(KEYS.map((k) => `wa_template:${k}`).sort())
      for (const key of KEYS) {
        expect(JSON.parse(rows[`wa_template:${key}`]), key).toEqual(seedJson(key))
        // Byte-exact on the stored value, key order included.
        expect(rows[`wa_template:${key}`], key).toBe(JSON.stringify(seedJson(key)))
      }
      const enabled = KEYS.filter((k) => JSON.parse(rows[`wa_template:${k}`]).enabled === 1)
      expect(enabled, 'D2: exactly the three operational templates on, plus custom (D3)').toEqual(['pickup', 'packeta', 'host', 'custom'])
    })
  })

  test('⚠ seeding NEVER overwrites: an edited row survives a reboot; a deleted one is re-seeded; the others untouched', () => {
    withTempDb((file) => {
      boot(file)
      const edited = JSON.stringify({ name: 'Doručené na odberné miesto', body: 'Ahoj {meno}!', enabled: 0 })
      setRow(file, 'wa_template:pickup', edited)
      setRow(file, 'wa_template:closing', '{not json')
      setRow(file, 'wa_template:custom', null)
      boot(file)
      const rows = templateRows(file)
      expect(rows['wa_template:pickup'], 'the admin\'s edit survives').toBe(edited)
      expect(rows['wa_template:closing'], 'even an INVALID row is never rewritten by the boot').toBe('{not json')
      expect(rows['wa_template:custom'], 'a missing row is seeded again').toBe(JSON.stringify(seedJson('custom')))
      expect(rows['wa_template:host']).toBe(JSON.stringify(seedJson('host')))
    })
  })

  test('getTemplate/listTemplates read the stored row: an edited body and `enabled` come back, `enabled` as a boolean', () => {
    withTempDb((file) => {
      boot(file)
      setRow(file, 'wa_template:closing', JSON.stringify({ name: 'Objednávky sa čoskoro zatvárajú', body: 'Do {datum}!', enabled: 1 }))
      const { out, logged } = probe(file, "return { one: templates.getTemplate('closing'), all: templates.listTemplates(), none: templates.getTemplate('nope') };")
      expect(out.one).toEqual({ key: 'closing', name: 'Objednávky sa čoskoro zatvárajú', body: 'Do {datum}!', enabled: true })
      expect(out.all.map((t) => t.key)).toEqual(KEYS)
      expect(out.all[0]).toEqual(seedTemplate('pickup'))
      expect(out.none, 'an unknown key is null, never a default').toBe(null)
      expect(logged).toEqual([])
    })
  })

  test('⚠ FAIL-QUIET: every invalid row reads as the SEED default and logs exactly ONE line per read; a missing row reads as the seed silently; nothing throws', () => {
    const invalid = {
      'not JSON': '{"name": "x", "body": ',
      'JSON null': 'null',
      'an array': '["Ahoj"]',
      'a string': '"Ahoj {meno}"',
      'body not a string': JSON.stringify({ name: 'x', body: 42, enabled: 1 }),
      'body missing': JSON.stringify({ name: 'x', enabled: 1 }),
      'body over 1000': JSON.stringify({ name: 'x', body: 'a'.repeat(1001), enabled: 1 }),
      'unknown placeholder': JSON.stringify({ name: 'x', body: 'Ahoj {menoo}', enabled: 1 }),
      'enabled "yes"': JSON.stringify({ name: 'x', body: 'Ahoj', enabled: 'yes' }),
      'enabled 2': JSON.stringify({ name: 'x', body: 'Ahoj', enabled: 2 }),
      'enabled missing': JSON.stringify({ name: 'x', body: 'Ahoj' }),
      'name not a string': JSON.stringify({ name: 7, body: 'Ahoj', enabled: 1 }),
    }
    withTempDb((file) => {
      boot(file)
      for (const [label, value] of Object.entries(invalid)) {
        setRow(file, 'wa_template:host', value)
        const { out, logged } = probe(file, "return { one: templates.getTemplate('host'), all: templates.listTemplates() };")
        expect(out.one, label).toEqual(seedTemplate('host'))
        expect(out.all.find((t) => t.key === 'host'), label).toEqual(seedTemplate('host'))
        expect(logged, `${label}: one line per read (two reads)`).toHaveLength(2)
        expect(logged[0], label).toMatch(/wa_template:host/)
        expect(logged[0].length, `${label}: a BOUNDED excerpt, never the whole blob`).toBeLessThan(500)
      }
      // `enabled: true/false` (a hand-written boolean) is valid, not a fallback.
      setRow(file, 'wa_template:host', JSON.stringify({ name: 'H', body: 'Ahoj {host}', enabled: false }))
      const ok = probe(file, "return templates.getTemplate('host');")
      expect(ok.out).toEqual({ key: 'host', name: 'H', body: 'Ahoj {host}', enabled: false })
      expect(ok.logged).toEqual([])
      // A MISSING row: the seed, and no log line (the next boot re-seeds it).
      setRow(file, 'wa_template:host', null)
      const missing = probe(file, "return templates.getTemplate('host');")
      expect(missing.out).toEqual(seedTemplate('host'))
      expect(missing.logged).toEqual([])
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §3 HTTP — GET/PUT /api/notifications/templates(/:key)
// ═════════════════════════════════════════════════════════════════════════════
let ctx
let adminToken
const admin = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
})

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => { await ctx?.dispose() })

async function listAll() {
  const res = await admin('/api/notifications/templates')
  expect(res.status(), 'GET templates').toBe(200)
  return res.json()
}
async function readOne(key) {
  return (await listAll()).templates.find((t) => t.key === key)
}
const put = (key, data) => admin(`/api/notifications/templates/${key}`, { method: 'put', data })
// A RAW JSON text body — for top-level shapes the object API cannot express.
const putRaw = (key, text) => admin(`/api/notifications/templates/${encodeURIComponent(key)}`, {
  method: 'put', data: text, headers: { 'Content-Type': 'application/json' },
})
// Put a template back to its seed (every PUT test restores, so the file re-runs on one DB).
async function restore(key) {
  const res = await put(key, { body: SEED[key].body, enabled: SEED[key].enabled })
  expect(res.status(), `restore ${key}`).toBe(200)
}

test.describe('WA-T2 · 21 §UC-WA-004 — GET /api/notifications/templates', () => {
  test('all six, in key order, byte-exact to the seed on a fresh database; the vocabulary rides along', async () => {
    const body = await listAll()
    expect(body.templates).toEqual(KEYS.map(seedTemplate))
    expect(body.placeholders).toEqual(VOCABULARY)
  })
})

test.describe('WA-T2 · 21 §UC-WA-004 — PUT /api/notifications/templates/:key', () => {
  test('happy path: body + enabled written, returned, and read back; a second PUT with ONE key leaves the other alone', async () => {
    try {
      const res = await put('closing', { body: 'Ahoj {meno}, {objednávka} sa zatvára {datum}. {odkaz}', enabled: true })
      expect(res.status()).toBe(200)
      const want = { key: 'closing', name: SEED.closing.name, body: 'Ahoj {meno}, {objednávka} sa zatvára {datum}. {odkaz}', enabled: true }
      expect(await res.json()).toEqual(want)
      expect(await readOne('closing')).toEqual(want)

      const off = await put('closing', { enabled: 0 })
      expect(off.status()).toBe(200)
      expect(await readOne('closing')).toEqual({ ...want, enabled: false })

      const text = await put('closing', { body: 'Len text.' })
      expect(text.status()).toBe(200)
      expect(await readOne('closing')).toEqual({ ...want, body: 'Len text.', enabled: false })

      // `name` is not editable: an extra key is ignored, never written.
      const named = await put('closing', { body: 'Text 2.', name: 'Iné meno' })
      expect(named.status()).toBe(200)
      expect((await readOne('closing')).name).toBe(SEED.closing.name)
    } finally {
      await restore('closing')
    }
    expect(await readOne('closing')).toEqual(seedTemplate('closing'))
  })

  test('an EMPTY body is legal (custom ships empty, D3); exactly 1000 chars is legal; 1001 ⇒ 400 and the row unchanged', async () => {
    try {
      expect((await put('custom', { body: '' })).status()).toBe(200)
      const max = 'a'.repeat(991) + ' {meno}..'
      expect(max).toHaveLength(1000)
      const ok = await put('custom', { body: max })
      expect(ok.status()).toBe(200)
      expect((await readOne('custom')).body).toBe(max)

      const long = await put('custom', { body: max + 'b' })
      expect(long.status()).toBe(400)
      expect(await long.json()).toMatchObject({ reason: 'body_too_long', field: 'body' })
      expect((await readOne('custom')).body, 'refusal writes nothing').toBe(max)
    } finally {
      await restore('custom')
    }
  })

  test('⚠ `{menoo}` ⇒ 400 unknown_placeholder naming the token, and the row is UNCHANGED (enabled in the same body is not applied either)', async () => {
    const before = await readOne('pickup')
    expect(before).toEqual(seedTemplate('pickup'))
    const res = await put('pickup', { body: 'Ahoj {menoo}', enabled: false })
    expect(res.status()).toBe(400)
    const err = await res.json()
    expect(err).toMatchObject({ reason: 'unknown_placeholder', token: '{menoo}', field: 'body' })
    expect(err.error, 'a Slovak message that names the token').toContain('{menoo}')
    expect(await readOne('pickup')).toEqual(before)

    const first = await put('pickup', { body: '{meno} {kolo} {x}' })
    expect(first.status()).toBe(400)
    expect((await first.json()).token, 'the FIRST offending token').toBe('{kolo}')
    expect(await readOne('pickup')).toEqual(before)

    // The non-ASCII placeholder (and its NFD spelling) is accepted.
    try {
      expect((await put('pickup', { body: 'Ahoj {meno}, {objednávka}.' })).status()).toBe(200)
      expect((await put('pickup', { body: 'Ahoj {meno}, {objednávka}.'.normalize('NFD') })).status()).toBe(200)
    } finally {
      await restore('pickup')
    }
  })

  test('⚠ unbindable top-level bodies ⇒ 400, never 500, and nothing written: `{}`, `true`, `[\'x\']`, `[1]`, `\'abc\'`, `null`, `42`; an only-unknown-keys body ⇒ 400 nothing to change', async () => {
    const before = await readOne('host')
    for (const raw of ['{}', 'true', '["x"]', '[1]', '[{"body":"x"}]', '"abc"', 'null', '42', '{"name":"x"}']) {
      const res = await putRaw('host', raw)
      expect(res.status(), raw).toBe(400)
    }
    const empty = await put('host', {})
    expect(await empty.json()).toMatchObject({ reason: 'nothing_to_change' })
    // A bodyless PUT (no JSON at all) is the same „nothing to change".
    const bare = await admin('/api/notifications/templates/host', { method: 'put' })
    expect(bare.status()).toBe(400)
    expect(await readOne('host')).toEqual(before)
  })

  test('⚠ `body` must be a STRING: number, null, boolean, array, one-element array, object ⇒ 400 {field:\'body\'}, row unchanged', async () => {
    const before = await readOne('host')
    for (const body of [42, null, true, ['Ahoj'], [], { toString: 1 }, { length: 2 }]) {
      const res = await put('host', { body })
      expect(res.status(), JSON.stringify(body)).toBe(400)
      expect(await res.json(), JSON.stringify(body)).toMatchObject({ field: 'body', reason: 'invalid_body' })
    }
    expect(await readOne('host')).toEqual(before)
  })

  test('⚠ `enabled` is a STRICT boolean: true/false/1/0 accepted; \'1\', \'true\', 2, null, [true], {} ⇒ 400 {field:\'enabled\'}, row unchanged', async () => {
    try {
      for (const [value, want] of [[false, false], [true, true], [0, false], [1, true]]) {
        const res = await put('waitlist', { enabled: value })
        expect(res.status(), String(value)).toBe(200)
        expect((await res.json()).enabled, String(value)).toBe(want)
        expect((await readOne('waitlist')).enabled).toBe(want)
      }
      const before = await readOne('waitlist')
      for (const enabled of ['1', 'true', 2, -1, null, [true], [1], {}, 0.5]) {
        const res = await put('waitlist', { enabled })
        expect(res.status(), JSON.stringify(enabled)).toBe(400)
        expect(await res.json(), JSON.stringify(enabled)).toMatchObject({ field: 'enabled', reason: 'invalid_enabled' })
      }
      // A bad `enabled` beside a GOOD body writes neither.
      const both = await put('waitlist', { body: 'Nový text {odkaz}', enabled: 'yes' })
      expect(both.status()).toBe(400)
      expect(await readOne('waitlist')).toEqual(before)
    } finally {
      await restore('waitlist')
    }
  })

  test('⚠ an unknown :key ⇒ 404 — including prototype names and the raw settings key — and no settings row is created', async () => {
    for (const key of ['nope', 'Pickup', 'test', 'wa_template:pickup', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const res = await putRaw(key, JSON.stringify({ body: 'Ahoj {meno}', enabled: true }))
      expect(res.status(), key).toBe(404)
      expect(await res.json(), key).toMatchObject({ reason: 'unknown_template' })
    }
    // An unknown key with an UNBINDABLE (but parseable) body is still a 404 — the key is
    // checked first. (A top-level `true` never reaches the route: express.json 400s it.)
    expect((await putRaw('nope', '[1]')).status()).toBe(404)
    expect((await putRaw('nope', '{}')).status()).toBe(404)
    expect((await listAll()).templates.map((t) => t.key)).toEqual(KEYS)
    if (DB_PATH) {
      const db = new DatabaseSync(DB_PATH, { readOnly: true })
      try {
        const rows = db.prepare("SELECT key FROM settings WHERE key LIKE 'wa\\_template:%' ESCAPE '\\' ORDER BY key").all().map((r) => r.key)
        expect(rows).toEqual(KEYS.map((k) => `wa_template:${k}`).sort())
      } finally {
        db.close()
      }
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §4 DB_PATH-gated — a hand-corrupted row on the SERVED database never 500s the page
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T2 · 21 §UC-WA-004 — a hand-edited row on the live database', () => {
  test.skip(!DB_PATH, NEEDS_DB)

  test('⚠ invalid JSON in `wa_template:packeta` ⇒ GET still 200 with the SEED default; a PUT repairs it from that default', async () => {
    const db = new DatabaseSync(DB_PATH)
    const original = db.prepare("SELECT value FROM settings WHERE key = 'wa_template:packeta'").get()?.value
    expect(original, 'non-vacuity: the boot seeded the row').toBeTruthy()
    try {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'wa_template:packeta'").run('{"name":"Odovzdané Packete","body":')
      const res = await admin('/api/notifications/templates')
      expect(res.status()).toBe(200)
      expect((await res.json()).templates.find((t) => t.key === 'packeta')).toEqual(seedTemplate('packeta'))

      // PUT {enabled} on the corrupt row: the merge base is the seed default, and the
      // row is rewritten whole (valid JSON again).
      const fix = await put('packeta', { enabled: false })
      expect(fix.status()).toBe(200)
      expect(await fix.json()).toEqual({ ...seedTemplate('packeta'), enabled: false })
      const stored = db.prepare("SELECT value FROM settings WHERE key = 'wa_template:packeta'").get().value
      expect(JSON.parse(stored)).toEqual({ ...seedJson('packeta'), enabled: 0 })
    } finally {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'wa_template:packeta'").run(original)
      db.close()
    }
    expect(await readOne('packeta')).toEqual(seedTemplate('packeta'))
  })
})
