// THE ONE HOME of "which round is the friend portal's landing about, and what
// state is it in" (18 §UC-PI-002). `FriendPortalSession.vue` calls
// `resolveLanding()` once per cycles load and every landing surface — the open
// grid, the closed modal, the locked own-order card, the appbar ticker, the
// drawer's first item — reads its result. Two copies of this precedence is exactly
// how one screen offers a catalogue for a round the other one calls closed.
//
// ⚠ THIS FILE RE-IMPLEMENTS NOTHING MODULE 17 ALREADY SHIPPED, and that is the
// whole reason it is this short. §UC-PI-002 is written as if `nextText` and the
// open→locked precedence were new; they are not:
//
//   · the precedence AND the two-open `console.warn` are `cycle-stages.js`
//     `currentCycleFor()` (17 §UC-CS-005). `resolveLanding` reads the STATUS of
//     what that function picked instead of re-deciding it, so the landing and
//     module 19's pre-open link cannot disagree about which round is current.
//   · the „Ďalšia objednávka…" sentence and its three branches are
//     `nextOpeningText()`. §UC-PI-002's `nextText` is the same three branches
//     word for word, so it DELEGATES.
//
// ⚠ RECORDED CONFLICT, NOT SILENTLY RESOLVED (PI-T1 — see `docs/learnings/
// 10-portal-ia.md` and the PO question there): 17 §UC-CS-005 renders that
// sentence with the LONG genitive month („približne 3. októbra"), 18 §UC-PI-002
// specifies `fmtDayMonth` („približne 3. 10.") for the SAME sentence. Both cannot
// be right. The shipped one wins here because the alternative is a second home for
// one sentence; `lib/dates.js` is still built as 18 specifies and is what every
// OTHER module-18 surface prints its dates with. `nextOpening` below carries 17's
// pieces so a caller can lay them out without recomposing anything.
//
// ⚠ DEPENDENCY-FREE ON PURPOSE (the `cycle-stages.js` rule): no Vue, no `@/`
// alias, no fetch, so a plain `node` — and therefore a Playwright spec — can
// import it and exercise every branch. This project has no unit runner.
//
// ⚠ VOCABULARY: no string in here may contain „kolo" / „cyklus" (18 §UC-PI-017).
// Today it owns no Slovak at all — every word it returns comes from
// `cycle-stages.js`.
import { currentCycleFor, newestCycleWith, nextOpeningText } from './cycle-stages.js'

/**
 * The landing's whole state, from a `GET /friends/cycles` array.
 *
 * ```
 * { state, currentCycle, catalogCycle, nextCycle, nextText, nextOpening }
 * ```
 *
 * | state    | when                        | `currentCycle`      |
 * |----------|-----------------------------|---------------------|
 * | `open`   | at least one `open` round   | the newest `open`   |
 * | `locked` | else at least one `locked`  | the newest `locked` |
 * | `closed` | else                        | `null`              |
 *
 * `catalogCycle` is the newest round with `status ∈ {locked, completed}` — the
 * read-only grid's source in the `closed` state, `null` when none exists. It is
 * filled in EVERY state (it costs one pass and the closed modal is not the only
 * consumer); the open state simply ignores it.
 *
 * `nextCycle` is the newest `planned` round, in every state — a locked round's
 * „Ďalšia objednávka …" banner needs it just as much as the closed one does.
 *
 * ⚠ `currentCycle` is deliberately `null` under `closed`, not "the newest planned
 * one". A planned round has no products a friend may look at; the thing a closed
 * landing renders a grid from is `catalogCycle`, and conflating the two is how a
 * planned round with an empty catalogue renders as an empty shop.
 */
export function resolveLanding(cycles, today = new Date()) {
  const list = Array.isArray(cycles) ? cycles : []
  // ⚠ ONE call, and its `console.warn` is the spec's two-open warning. Do not add
  // a second `open` scan beside it — the warning would then fire twice per load
  // and the precedence would have two homes.
  const current = currentCycleFor(list)
  const status = current ? current.status : null
  const state = status === 'open' ? 'open' : status === 'locked' ? 'locked' : 'closed'

  const nextCycle = newestCycleWith(list, ['planned'])
  const nextOpening = nextOpeningText(nextCycle, today)

  return {
    state,
    currentCycle: state === 'closed' ? null : current,
    catalogCycle: newestCycleWith(list, ['locked', 'completed']),
    nextCycle,
    // 17's finished sentence, verbatim. A surface that needs the date and the
    // „o n týždňov" apart reads `nextOpening.date` / `.inWeeks` rather than
    // splitting this string.
    nextText: nextOpening.text,
    nextOpening,
  }
}
