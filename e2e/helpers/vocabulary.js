import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { FRONTEND_SRC, stripComments } from './source-pins.js'

// ONE HOME for the vocabulary ban — 18 §UC-PI-017 / 17 §UC-CS-005, 00-overview
// glossary: the words „cyklus" and „kolo" (any inflection) never reach a friend or a
// guest. „cyklus" survives on ADMIN screens and in the glossary.
//
// ⚠⚠ WHY THIS FILE EXISTS, AND IT IS THE LOUDEST RULE IN THIS REPO'S HISTORY. When
// PI-T11 started there were THREE spellings of this one ban, and no two of them banned
// the same set of words:
//
//   shipped   `/\bkol[oáa]|cykl/iu`            `cycle-stages.spec.js:1434`, module-scoped,
//                                              never exported, two consumers in that file
//   17 spec   `/kol[oáa]\b|cykl/i`             §UC-CS-009
//   18 spec   `/cykl|\bkol(o|a|e|u|om|á|ách)\b/i`  §UC-PI-017
//
// Neither shipped nor spec is a superset of the other — the shipped one misses „kole",
// „kolu"; 17's misses „kolá" (`á` is outside ASCII `\w`, so the TRAILING `\b` never
// fires after it) and false-positives „okolo"; 18's misses „kolá" for the same reason
// and, with a leading-`\b`-free reading, would have caught „kolega". A rule with three
// copies is a rule with two of them wrong, which is exactly what CLAUDE.md
// §Documentation discipline says. So: ONE regex, here, imported by both readers, and a
// table of cases below it that PROVES the union rather than asserting it on faith.
//
// ── THE REGEX, CHARACTER BY CHARACTER ────────────────────────────────────────
// `cykl` — unconditional. Every Slovak inflection of „cyklus" contains it, and no
//   other Slovak word a friend surface would say does.
// `(?<!LETTER)(?:kol(?:…)|kôl)(?!LETTER)` — „kolo" and its case forms as a WHOLE WORD.
//   The FULL paradigm, singular and plural: kolo/kola/kolu/kole/kolom, kolá/kôl/kolám/
//   kolách/kolami. ⚠ The plural dative „kolám", instrumental „kolami" and genitive „kôl"
//   were MISSING from the first cut (found in PI-T11's review): three of the ten forms, and
//   „kôl" is not even spelled with an `o`. Every form is in `BANNED_CASES.bad`.
//
// ⚠ `\b` CANNOT DO THIS JOB and that is a measurement, not taste: JavaScript's `\b` is
// defined on ASCII `\w`, so `á`, `č`, `ž` are non-word characters to it. „kolá" at the
// end of a string therefore has NO boundary after it (`á` and EOF are both non-word)
// while „kolá" inside „kolách" does. A ban that misses one of the four words it names
// is the bug. The explicit Slovak letter class fixes both directions at once: it is
// what makes „kolegovia" (kol + e + a LETTER) and „okolo" (a LETTER + kol) pass, and
// „kolá" / „kolách" / „kolom" red.
//
// ⚠ It is STRICTLY NARROWER than the shipped regex on one family, deliberately:
// „kolaps", „kolotoč", „kolaudácia" matched `\bkol[oáa]` and no longer match anything.
// Those are false positives the shipped ban was one product name away from firing on.
// Every string the shipped ban caught ON PURPOSE (its own positive list in
// `cycle-stages.spec.js`) is still caught — that file's table is the regression net.

/** The Slovak alphabet, for the two word-boundary assertions. Case-insensitive flag covers the capitals. */
const LETTER = '[a-záäčďéíĺľňóôŕšťúýž]'

/**
 * The ban. „cyklus"/„cykle"/„cyklov"/… and „kolo" in every case form, as whole words.
 *
 * ⚠ NOT `/g`: a `lastIndex` that survives between calls makes `.test()` alternate
 * true/false on the SAME string, which in a `.filter()` over a page's copy would drop
 * every second offender.
 */
export const BANNED = new RegExp(`cykl|(?<!${LETTER})(?:kol(?:ách|ami|ám|om|o|a|á|e|u)|kôl)(?!${LETTER})`, 'iu')

/**
 * The proof table for `BANNED`, exported so the two spec files that read the regex can
 * both run it — a ban whose regex matches nothing is the same bug as a sweep over
 * nothing (CS-T2).
 *
 * `bad` — all ten case forms of „kolo" (singular AND plural — „kolám", „kolami" and
 * „kôl" were added in PI-T11's review, the first cut had missed them), plus sentences.
 * `good` — the words this app says ON PURPOSE. „kolega"/„kolegov"/„kolegami" is the
 * host's word for the people on their share link and appears in shipped `aria-label`s;
 * „okolo" is module 18's own copy („Káva príde okolo {date}", PO decision O2); the rest
 * are ordinary Slovak that shares a prefix with a banned form („kolaps"/„kolotoč" were
 * red-lined by the old `\bkol[oáa]` spelling; „kôlňa" shares „kôl").
 */
export const BANNED_CASES = {
  bad: [
    'kolo', 'kola', 'kolá', 'kole', 'kolu', 'kolom', 'kolách', 'kolám', 'kolami', 'kôl',
    'cyklus', 'cykle', 'k ďalším kolám', 'medzi kolami', 'päť kôl',
    'Pripravujeme ďalšie kolo', 'Kolo ukončené', 'Objednávanie v tomto cykle je uzavreté',
    'dve kolá', 'v troch kolách', 'v tomto kole', 'k tomuto kolu', 'pred kolom', '„kolo"',
  ],
  good: [
    'kolegovia', 'Kolegovia', 'kolega', '1 kolega', '5 kolegov', 'Zdieľať s kolegami',
    'Objednávka alebo kolegovia', 'okolo', 'Káva príde okolo 24. 9.',
    'Pripravujeme ďalšiu objednávku', 'Objednávka ukončená', 'Zabalené, rozvážame',
    'Kolumbia', 'kolaps', 'kolotoč', 'kolegami', 'kolónka', 'kolíska', 'kôlňa',
  ],
}

// ── THE GUARDED FILE SET — DERIVED, NEVER LISTED ─────────────────────────────
//
// ⚠ §UC-PI-017 states the guard as a `grep -rniE … <file list>`, and that list has
// already failed twice in the way CLAUDE.md predicts: THREE files were missing from it
// and were added only in the PI-T4 review (`LandingStateModal.vue`, `CycleTimeline.vue`,
// `lib/cycle-stages.js`). The predicate is a CLASS — „every file that renders Slovak
// copy to a friend-facing portal surface" — and a class enumerated by hand goes stale
// the moment someone adds a component. PI-T10 shipped that same failure twice in one row.
//
// So the set is COMPUTED: the import closure of the friend-surface ROUTE ENTRIES. Two
// roots, taken straight from `router.js`, and everything they can reach. A new component
// joins the guard by being imported, which is the only way it can reach a friend anyway.
//
// ~~⚠ WHAT IS DELIBERATELY NOT A ROOT. `views/GuestOrder.vue` and
// `views/GuestOrderStatus.vue` are the GUEST surface, and TWO „cyklus" strings there
// survive on purpose pending a PO decision …~~ **SUPERSEDED by GL-T7 (19 §UC-GL-011,
// module-19 closeout): the guest surface IS guarded now.** The last client offender
// (`GuestProductGrid.vue:88`'s empty-grid default) and the guest-facing server
// messages (`routes/guest.js` ×4, the host 409s in `routes/guest-orders.js` ×2) were
// swept in the same row; learnings 11 §GL-T7 has the table. The two guest roots are a
// SEPARATE list rather than two more entries in `FRIEND_SURFACE_ROOTS` — the row said
// „add them to FRIEND_SURFACE_ROOTS", but that name is read by §2 of
// `portal-vocabulary.spec.js` as „the FRIEND surface" (its superset/admin-only pins),
// and a guest view in a list called FRIEND is the kind of lie a later reader acts on.
// The ban covers the UNION (`VOCABULARY_ROOTS`); `importClosure()`'s default stays
// the friend closure so `portal-shell.spec.js`'s callers keep measuring what they did.
//
// ⚠ The closure reaches `components/ui/*` (shadcn) and `api.js`. That is correct, not
// over-collection: they render on a friend's screen, so a Slovak string in them is a
// friend-facing string. It is also why the check strips comments — the headers of
// `lib/cycle-stages.js` and `lib/portal-state.js` NAME the banned words in order to ban
// them, and a raw line sweep reds on its own documentation.

/** The two routes a friend can be on. `router.js` `/`+3 views → FriendPortal, `/cycle/:id` → FriendOrder. */
export const FRIEND_SURFACE_ROOTS = ['views/FriendPortal.vue', 'views/FriendOrder.vue']

/**
 * The public guest routes' components — `router.js` `/g/:token` → GuestOrder,
 * `/g/o/:orderToken` + `/g/:token/o/:orderToken` → GuestOrderStatus (GL-T7).
 * `portal-vocabulary.spec.js` §6 pins this list EQUAL to what the router maps `/g/…` to,
 * so a new guest route reds instead of escaping the guard.
 */
export const GUEST_SURFACE_ROOTS = ['views/GuestOrder.vue', 'views/GuestOrderStatus.vue']

/** Every surface the ban applies to: the friend portal AND the guest pages. */
export const VOCABULARY_ROOTS = [...FRIEND_SURFACE_ROOTS, ...GUEST_SURFACE_ROOTS]

const RESOLVE_SUFFIXES = ['', '.js', '.ts', '.vue', '/index.js', '/index.ts']

/** `import … from '…'`, `export … from '…'` and `import('…')`, which is how the router lazy-loads. */
const IMPORT_RE = /(?:import|export)\s[^'"();]*from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

function resolveSpec(spec, fromRel) {
  let base
  if (spec.startsWith('@/')) base = join(FRONTEND_SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(FRONTEND_SRC, dirname(fromRel), spec)
  else return null // a package — not this repo's source
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(FRONTEND_SRC, candidate)
  }
  // Loud rather than silent: a spec this resolver cannot follow is a hole in the guard.
  return `UNRESOLVED:${spec} (from ${fromRel})`
}

/**
 * Every file under `frontend/src` reachable from `roots`, sorted. Paths are relative to
 * `frontend/src`, the same spelling `helpers/source-pins.js` reads.
 */
export function importClosure(roots = FRIEND_SURFACE_ROOTS) {
  const seen = new Set()
  const queue = [...roots]
  while (queue.length) {
    const rel = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)
    if (rel.startsWith('UNRESOLVED:')) continue
    const text = readFileSync(join(FRONTEND_SRC, rel), 'utf8')
    IMPORT_RE.lastIndex = 0
    let m
    while ((m = IMPORT_RE.exec(text))) {
      const resolved = resolveSpec(m[1] || m[2], rel)
      if (resolved) queue.push(resolved)
    }
  }
  return [...seen].sort()
}

/**
 * The offenders in one file: `[n, line]` pairs over the COMMENT-STRIPPED text.
 *
 * ⚠ `n` is the line number in the STRIPPED text, not in the file — `stripComments()`
 * collapses a block comment to one space and takes its newlines with it. The pair
 * carries the offending LINE, which is what a reader greps for; a line number that
 * drifted would be worse than none. The strip itself is `source-pins.js`'s, not a
 * second copy: its ORDER (HTML, then line, then block) is the load-bearing part, and a
 * `/*` inside a `//` comment otherwise swallows 16 709 characters of
 * `FriendPortalSession.vue`.
 */
export function bannedLines(relPath) {
  return stripComments(readFileSync(join(FRONTEND_SRC, relPath), 'utf8'))
    .split('\n')
    .map((line, i) => [i + 1, line.trim()])
    .filter(([, line]) => BANNED.test(line))
}
