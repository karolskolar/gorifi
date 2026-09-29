// THE ONE HOME for everything a friend or a guest reads about where a round's
// coffee is (17 §UC-CS-005): the six steps, their labels, the dates under them and
// the „o n týždňov" derivation. Three modules print from here — `CycleTimeline.vue`
// (this row), module 18's landing/closed modal/banner, module 19's pre-open page
// (~~⚠ GL-T5: that page takes `fmtDay()` + `daysUntil()` from here but its „(…)" from
// `plural.js weeksAwayLabel()` — 19 §UC-GL-006's own draft register; PO question
// open~~ → RESOLVED, PO decision (4) 2026-09-24 / GP-T7: it takes `fmtDay()` +
// `inWeeksText()` from here, one register, see learnings 12 §GP-T7) —
// and the whole point of the file is that they cannot disagree about a word or a
// date format. A consumer lays the pieces out; it never re-composes a sentence from
// `opens_at` / `closes_at` / `stage` by hand.
//
// ⚠ DEPENDENCY-FREE ON PURPOSE. It imports `./plural.js` and nothing else — no Vue,
// no `@/` Vite alias, no fetch — so a plain `node` (and therefore a Playwright spec,
// §UC-CS-009 item 4) can import it and exercise every branch. This project has no
// unit runner; that import IS the unit test, and it only keeps working while this
// file stays pure.
//
// ⚠ VOCABULARY. No string in here may contain „kolo" / „kolá" / „cyklus" / „cykl"
// (resolved conflict 2: every friend- and guest-facing string says „objednávka";
// „cyklus" survives only on admin screens and in the glossary). Pinned by a regex
// sweep in `cycle-stages.spec.js` that harvests the six labels plus every builder's
// output, so a new string cannot slip past it unless it is also unreachable. The
// register is the impersonal vy-form: no participle addresses the reader.
import { daysLabel, weeksLabel } from './plural.js'

/** `YYYY-MM-DD`, the storage format UC-CS-002 validates at the write. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

// The six friend-facing steps, index = position (17 §UC-CS-005 table, copy drafted
// for the PO staging review — §OPEN O1). `key` is the stable identifier a consumer
// may switch on and the component writes into `data-step`; `label` is the only
// place these words exist.
//
// ⚠ The keys are NOT the `order_cycles.stage` enum, even where they share three
// spellings: `stage` has three values (`ordered`/`arrived`/`ready`) and is
// meaningful only while `status = 'locked'`, while these six span STATUS and stage
// together. `stageIndex()` below is the one translation between them.
//
// Frozen because "one home" is the rule this file enforces on everybody else: a
// consumer that wanted a different word would otherwise be one assignment away
// from changing it for every other surface too.
export const STEPS = Object.freeze([
  Object.freeze({ key: 'planned', label: 'Pripravujeme ďalšiu objednávku' }),
  Object.freeze({ key: 'open', label: 'Objednávky otvorené' }),
  Object.freeze({ key: 'ordered', label: 'Objednávky uzavreté, káva objednaná v pražiarni' }),
  Object.freeze({ key: 'arrived', label: 'Káva dorazila, balíme' }),
  Object.freeze({ key: 'ready', label: 'Zabalené, rozvážame' }),
  Object.freeze({ key: 'completed', label: 'Objednávka ukončená' }),
])

/**
 * Which of the six steps a cycle is ON. `null`/`undefined`/junk ⇒ 0.
 *
 * ⚠ `status` IS CONSULTED BEFORE `stage`, AND THAT ORDER IS LOAD-BEARING — it is
 * not a style preference. CS-T1 measured three transitions that leave a `stage`
 * disagreeing with its `status` (docs/learnings/09-cycle-stages.md §10):
 *
 *   A `locked(ready) → planned`   leaves `stage = 'ready'`
 *   B `completed(ready) → open`   leaves `stage = 'ready'`
 *   C `completed(ready) → locked` RESETS `stage` to `'ordered'`
 *
 * None of the three is a backend bug this row may fix (§UC-CS-002 does not name
 * those transitions), and none is pinned anywhere else. They stay invisible ONLY
 * because this function reads `status` first: A and B render from `planned`/`open`
 * and never look at the stale value, and C renders step 2 for a cycle that
 * genuinely is locked again. Consult `stage` before `status` — or let `stage`
 * override `status` in any single branch — and all three surface on the friend's
 * timeline at once, with nothing going red anywhere in the suite. That is what the
 * `status`-first pin in `cycle-stages.spec.js` exists for.
 *
 * Under `locked`, an unknown or NULL `stage` reads as `ordered` (step 2): the
 * no-backfill rule (§UC-CS-001) leaves every locked cycle in production at NULL,
 * so this is the common case, not the defensive one.
 */
export function stageIndex(cycle) {
  if (!cycle || typeof cycle !== 'object') return 0
  switch (cycle.status) {
    case 'planned':
      return 0
    case 'open':
      return 1
    case 'locked':
      if (cycle.stage === 'ready') return 4
      if (cycle.stage === 'arrived') return 3
      return 2
    case 'completed':
      return 5
    default:
      return 0
  }
}

/**
 * The six steps decorated for rendering: `{ key, label, when, desc, state }`,
 * `state` being `'done'` before the current step, `'now'` on it, `'next'` after.
 *
 * `when` is rendered only where it is DERIVABLE from the fixed column set: steps
 * 0-2 read `opens_at` / `closes_at`, steps 3-5 have no timestamp to print and stay
 * `''` (resolved conflict 8 — the prototype's „dnes, 23. 9." / „≈ 25. 9." need
 * per-stage timestamps that were dropped). `desc` is `''` for every step in v1; the
 * slot exists so modules 18/21 can inject their own sentences through the
 * component's `steps` prop without a second copy of the labels.
 *
 * ⚠ `when` does NOT depend on `state`: step 1 prints „do {closes_at}" whether the
 * round is open, closed or finished, because the deadline is a fact about the round
 * and a friend reading a finished timeline still wants to see it.
 */
export function timelineSteps(cycle) {
  const current = stageIndex(cycle)
  const opens = fmtDay(cycle ? cycle.opens_at : '')
  const closes = fmtDay(cycle ? cycle.closes_at : '')
  const when = [
    opens ? `otvorí sa ${opens}` : '',
    closes ? `do ${closes}` : '',
    closes,
    '',
    '',
    '',
  ]
  return STEPS.map((step, i) => ({
    key: step.key,
    label: step.label,
    when: when[i],
    desc: '',
    state: i < current ? 'done' : i === current ? 'now' : 'next',
  }))
}

/**
 * ISO date ⇒ „3. októbra". Anything else ⇒ `''` — never a throw, never the string
 * „Invalid Date" on a friend's screen.
 *
 * ⚠ THE REGEX ALONE IS NOT VALIDATION, and the trap is quiet: V8 parses
 * `new Date('2026-02-31T00:00:00')` as **3 March**, not as Invalid Date. So the
 * shape check is followed by the same UTC round-trip the route uses (§UC-CS-002),
 * which is the only thing that rejects an impossible calendar day. The DISPLAY date
 * is then built from LOCAL midnight, as the spec writes it, so the printed day can
 * never slide by one in a negative-offset zone.
 *
 * The long Slovak month in a date is ICU's genitive („októbra", not „október"),
 * which is exactly the form the prototype prints. The year is never printed: these
 * dates are always a few weeks out, and the prototype prints none.
 */
export function fmtDay(iso) {
  if (typeof iso !== 'string' || !ISO_DATE.test(iso)) return ''
  const utc = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== iso) return ''
  return new Date(`${iso}T00:00:00`).toLocaleDateString('sk-SK', { day: 'numeric', month: 'long' })
}

/**
 * Whole CALENDAR days from `today` to `iso`; `null` on anything unparseable.
 *
 * ⚠ Both sides are collapsed to UTC midnight before they are subtracted. Doing the
 * arithmetic on local timestamps makes a DST boundary produce 6.96 days, which
 * `Math.round` then turns into a silently wrong „o 7 dní" — or, worse, `< 7` flips
 * and the whole sentence changes shape. Two UTC midnights are always an exact
 * multiple of 86 400 000 ms apart.
 */
export function daysUntil(iso, today = new Date()) {
  if (typeof iso !== 'string' || !ISO_DATE.test(iso)) return null
  const target = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(target.getTime()) || target.toISOString().slice(0, 10) !== iso) return null
  const ref = today instanceof Date ? today : new Date(today)
  if (!(ref instanceof Date) || Number.isNaN(ref.getTime())) return null
  const refUtc = Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate())
  return Math.round((target.getTime() - refUtc) / DAY_MS)
}

/**
 * „o 3 dni" / „o 4 týždne" — the accusative after „o", declined by `plural.js`.
 * `null` when there is nothing to announce: an unparseable date, today, or a date
 * that has already passed (the caller then prints the date alone).
 *
 * Under a week the count is DAYS (PO decision O6); from seven days up it is weeks,
 * rounded — 7 ⇒ „o 1 týždeň", 18 ⇒ „o 3 týždne", 35 ⇒ „o 5 týždňov".
 */
export function inWeeksText(iso, today = new Date()) {
  const d = daysUntil(iso, today)
  if (d === null || d <= 0) return null
  if (d < 7) return `o ${daysLabel(d)}`
  return `o ${weeksLabel(Math.round(d / 7))}`
}

/**
 * What to say about the NEXT round, as three pieces plus the finished sentence:
 * `{ date, inWeeks, text }` (R1.3's three branches).
 *
 *   1. a planned round with a usable `opens_at` ⇒ the date, the „o n týždňov" when
 *      it is still ahead, and „Ďalšia objednávka sa otvorí približne {date} (…)."
 *   2. a planned round with only a `plan_note` ⇒ the note VERBATIM, newlines and
 *      all (the consumer renders it under `white-space: pre-line`)
 *   3. nothing planned ⇒ „O ďalšej objednávke dáme vedieť."
 *
 * Branch 1 is gated on `fmtDay()` rather than on the raw column, so a malformed
 * `opens_at` falls through to the note or the fallback instead of printing the
 * sentence with a hole in it. The three pieces are returned separately because the
 * prototype's closed modal sets the date in display type on its own line while the
 * banner prints one flowing sentence — same words, two layouts, one source.
 */
export function nextOpeningText(plannedCycle, today = new Date()) {
  const cycle = plannedCycle && typeof plannedCycle === 'object' ? plannedCycle : null
  const date = cycle ? fmtDay(cycle.opens_at) : ''
  if (date) {
    const inWeeks = inWeeksText(cycle.opens_at, today)
    return {
      date,
      inWeeks,
      text: `Ďalšia objednávka sa otvorí približne ${date}${inWeeks ? ` (${inWeeks}).` : '.'}`,
    }
  }
  const note = cycle && typeof cycle.plan_note === 'string' ? cycle.plan_note : ''
  if (note.trim()) return { date: null, inWeeks: null, text: note }
  return { date: null, inWeeks: null, text: 'O ďalšej objednávke dáme vedieť.' }
}

/**
 * The open round's status line: „Objednávky otvorené · do 12. septembra", or the
 * bare „Objednávky otvorené" when no deadline is stored (or the stored one is
 * unusable).
 *
 * ⚠ PO decision O2: `closes_at` is the ORDERING DEADLINE and `expected_date` is the
 * DELIVERY expectation. This builder reads `closes_at` only; the cartbar's fallback
 * to `expected_date` is module 18's decision and lives at its call site.
 */
export function openUntilText(cycle) {
  const closes = fmtDay(cycle ? cycle.closes_at : '')
  return closes ? `Objednávky otvorené · do ${closes}` : 'Objednávky otvorené'
}

/**
 * The round a landing page or a link should DESCRIBE, picked from a
 * `GET /friends/cycles` array: the newest `open`, else the newest `locked`, else
 * the newest `planned`, else `null`. `completed` rounds are never "current".
 *
 * ⚠ This exists so module 18's landing and module 19's link cannot disagree about
 * which round is current — two copies of this precedence is exactly how one screen
 * offers a catalogue for a round the other one calls closed.
 *
 * "Newest" is `created_at` DESC then `id` DESC: `created_at` is second-resolution,
 * so two rounds created in the same second tie on it and the id is what breaks the
 * tie deterministically (CLAUDE.md, the `, id DESC` rule).
 *
 * Two simultaneously open rounds are a data error the app cannot resolve (R1.2):
 * the newest wins and a `console.warn` names the condition, because silently
 * picking one is how it goes unnoticed for a month.
 */
export function currentCycleFor(cycles) {
  const open = cyclesWith(cycles, ['open'])
  if (open.length > 1) {
    console.warn(`[cycle-stages] ${open.length} cycles are open at once — using the newest`)
  }
  return newestCycleWith(cycles, ['open'])
    || newestCycleWith(cycles, ['locked'])
    || newestCycleWith(cycles, ['planned'])
}

/**
 * The NEWEST cycle whose `status` is one of `statuses`, or `null`.
 *
 * ⚠ Extracted for module 18's `resolveLanding()` (18 §UC-PI-002), which needs two
 * more picks off the same list — the newest `planned` REGARDLESS of whether
 * something is open (`nextCycle`), and the newest of the UNION `{locked,
 * completed}` (`catalogCycle`) — and must not carry a second copy of "newest".
 * `currentCycleFor()` above is still the ONE home of the open→locked→planned
 * PRECEDENCE and of the two-open warning; this is only the sort it precedences
 * over. Calling it once per status group is what keeps the precedence; calling it
 * with several statuses at once asks the union question instead, which is exactly
 * what `catalogCycle` is.
 *
 * "Newest" is `created_at` DESC then `id` DESC: `created_at` is second-resolution,
 * so two rounds created in the same second tie on it and the id is what breaks the
 * tie deterministically (CLAUDE.md, the `, id DESC` rule).
 */
export function newestCycleWith(cycles, statuses) {
  const matches = cyclesWith(cycles, statuses)
  return matches.length ? matches.slice().sort(newestFirst)[0] : null
}

function cyclesWith(cycles, statuses) {
  if (!Array.isArray(cycles)) return []
  const wanted = Array.isArray(statuses) ? statuses : [statuses]
  return cycles.filter((c) => c && typeof c === 'object' && wanted.includes(c.status))
}

function newestFirst(a, b) {
  const at = String(a.created_at || '')
  const bt = String(b.created_at || '')
  if (at !== bt) return at < bt ? 1 : -1
  return Number(b.id || 0) - Number(a.id || 0)
}
