// THE ONE HOME for the SHORT date forms module 18 prints (18 §UC-PI-002,
// „Dates one home"): „12. 9.", „12. 9. 2026", „piatku 12. 9.", and the whole-weeks
// count behind a „(o 3 týždne)" suffix. The drawer's „Otvorené do {fmtDate}", the
// open status line's „Objednávky do {fmtWeekdayDayMonth}" and the closed modal's
// big „{fmtDayMonth}" all read from here, so those three surfaces cannot disagree
// about how a date looks.
//
// ⚠ THIS IS **NOT** A SECOND HOME FOR THE LONG FORM. `lib/cycle-stages.js`
// `fmtDay()` („3. októbra", genitive month) is module 17's, it is what every
// `nextOpeningText` / `openUntilText` / `timelineSteps` sentence is built from, and
// nothing here may be used to re-compose one of those sentences. The split is by
// SENTENCE, not by taste: a date that stands alone in display type or after a
// preposition is short; a date inside one of 17's composed sentences is long.
// See the recorded PO question in `docs/learnings/10-portal-ia.md` (PI-T1) — the
// two specs disagree about which form the „Ďalšia objednávka…" sentence uses, and
// until the PO rules, that ONE sentence keeps module 17's shipped form.
//
// ⚠ DEPENDENCY-FREE ON PURPOSE, exactly like `cycle-stages.js`: no Vue, no `@/`
// alias, no fetch, so a plain `node` (and therefore a Playwright spec) can import
// it and exercise every branch. This project has no unit runner; that import IS
// the unit test, and it only keeps working while this file stays pure.
//
// ⚠ VOCABULARY: no string in here may contain „kolo" / „cyklus" (18 §UC-PI-017).
// Today it owns no Slovak at all except the seven genitive weekdays.

/** `YYYY-MM-DD` — the storage shape 17 §UC-CS-002 validates at the write. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/**
 * Genitive weekdays, indexed by `Date#getDay()` (0 = Sunday). ICU's `weekday:
 * 'long'` gives the NOMINATIVE („piatok"), and „Objednávky do piatok 12. 9." is
 * not Slovak — so the seven forms are spelled out rather than derived.
 */
const WEEKDAY_GENITIVE = Object.freeze([
  'nedele', 'pondelka', 'utorka', 'stredy', 'štvrtka', 'piatku', 'soboty',
])

/**
 * The one parse. `null` for anything that is not a real calendar day.
 *
 * ⚠ THE REGEX ALONE IS NOT VALIDATION and the trap is quiet (CS-T2 measured it):
 * V8 parses `new Date('2026-02-31T00:00:00')` as **3 March**, not as Invalid Date.
 * So the shape check is followed by a UTC round-trip, which is the only thing that
 * rejects an impossible day. The value HANDED BACK is then built from LOCAL
 * midnight, so the printed day can never slide by one in a negative-offset zone.
 */
function parseIso(iso) {
  if (typeof iso !== 'string' || !ISO_DATE.test(iso)) return null
  const utc = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== iso) return null
  return new Date(`${iso}T00:00:00`)
}

/**
 * `'2026-09-12'` ⇒ `'12. 9.'`.
 *
 * ⚠ An UNPARSABLE value renders the RAW STRING (18 §UC-PI-002: „an unparsable
 * value renders the raw string"), which is the opposite of `cycle-stages.js`
 * `fmtDay()`'s empty string — and deliberately so. 17's builders drop a bad date
 * because they would otherwise compose a sentence with a hole in it; here the date
 * IS the whole rendered thing, so showing the stored value is more useful to the
 * admin who typed it than showing nothing at all. A non-string (`null`,
 * `undefined`, a number, an object) is not "a raw string" and yields `''`.
 */
export function fmtDayMonth(iso) {
  const d = parseIso(iso)
  if (!d) return typeof iso === 'string' ? iso : ''
  return d.toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric' })
}

/** `'2026-09-12'` ⇒ `'12. 9. 2026'`. Same raw-string fallback as `fmtDayMonth`. */
export function fmtDate(iso) {
  const d = parseIso(iso)
  if (!d) return typeof iso === 'string' ? iso : ''
  return d.toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric' })
}

/**
 * `'2026-09-11'` ⇒ `'piatku 11. 9.'` — the form that reads after „do" in
 * „Objednávky do piatku 11. 9." (18 §UC-PI-005). Same raw-string fallback.
 */
export function fmtWeekdayDayMonth(iso) {
  const d = parseIso(iso)
  if (!d) return typeof iso === 'string' ? iso : ''
  return `${WEEKDAY_GENITIVE[d.getDay()]} ${fmtDayMonth(iso)}`
}

/**
 * Whole weeks from `today` to `iso`, rounded — `Math.round(days / 7)` (18
 * §UC-PI-002). `null` when there is nothing to count: an unparsable date, today,
 * or a date already past.
 *
 * ⚠ Both sides collapse to UTC midnight before the subtraction. Doing the
 * arithmetic on local timestamps makes a DST boundary produce 6.96 days, which
 * `Math.round` then turns into a silently wrong count (the CS-T2 lesson). Two UTC
 * midnights are always an exact multiple of 86 400 000 ms apart.
 *
 * ⚠ It returns a NUMBER, never a declined phrase. „o 3 týždne" is `plural.js`'s
 * `weeksLabel()` and there is exactly one home for those forms.
 */
export function weeksUntil(iso, today = new Date()) {
  const target = parseIso(iso)
  if (!target) return null
  // ⚠ `new Date(null)` and `new Date(0)` are VALID Dates at the epoch, not Invalid —
  // so a default-parameter guard alone lets a null clock through and this returned
  // 2961 (weeks since 1970) instead of `null`. Measured in the PI-T1 review, before
  // any caller existed; PI-T2's drawer sub-line and PI-T4's „(o n týždňov)" are the
  // intended callers, and a not-yet-loaded clock is exactly the value that arrives as
  // `null`. `undefined` still means „now" (that IS the default); anything else must be
  // a Date or a finite timestamp.
  if (today === null) return null
  const ref = today instanceof Date
    ? today
    : (typeof today === 'number' && Number.isFinite(today) && today !== 0)
      ? new Date(today)
      : (typeof today === 'string' ? new Date(today) : null)
  if (!(ref instanceof Date) || Number.isNaN(ref.getTime())) return null
  const targetUtc = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate())
  const refUtc = Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate())
  const days = Math.round((targetUtc - refUtc) / DAY_MS)
  if (days <= 0) return null
  return Math.round(days / 7)
}
