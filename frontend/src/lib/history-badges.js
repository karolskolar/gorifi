// THE ONE HOME of „Moje objednávky"'s SHORT status words (18 §UC-PI-009).
//
// ⚠⚠ THIS IS A SANCTIONED **SECOND** STATUS VOCABULARY, AND IT IS NOT A COPY OF
// MODULE 17's. Read this before „fixing" it by importing `lib/cycle-stages.js`.
//
// Module 17 (`lib/cycle-stages.js STEPS`) owns the LONG, sentence-shaped labels the
// TIMELINE prints — one per step, read one at a time, on a screen whose whole job is
// to explain where this round's coffee is:
//
//     'Objednávky uzavreté, káva objednaná v pražiarni'
//     'Káva dorazila, balíme'
//     'Zabalené, rozvážame'
//     'Objednávka ukončená'
//
// This file owns the SHORT ones — Odoslaná · V pražiarni · Balíme · Zabalená ·
// Odovzdaná · Vyzdvihnuté — which sit as a `span.badge` in the head row of a
// history card, beside a round's name and its total, in a LIST the friend scans.
// 18 §UC-PI-009 states the split in as many words („⚠ These are the SHORT history
// forms owned here; the timeline's long labels are module 17's") and its badge table
// is where these six strings are specified.
//
// ⚠ WHY A SHARED VOCABULARY WOULD BE WORSE, not merely different. The one-home rule
// this repo applies everywhere is about a single FACT with two renderings drifting
// apart — a price, a variable symbol, a kg label. These are not one fact rendered
// twice: they are two registers for two surfaces, and the words are chosen against
// their surroundings. Import `STEPS` here and every badge in the history list grows
// a comma and a subordinate clause („Objednávky uzavreté, káva objednaná
// v pražiarni" inside a 14px badge next to a 20px round name), wrapping to three
// lines at 320 px. Shorten `STEPS` instead and the timeline — which has no round
// name, no total and nothing else to lean on — stops being a sentence anybody can
// read. Neither direction is a fix; the duplication that looks wrong here is the
// thing keeping both screens legible.
//
// ⚠ WHAT IS GENUINELY SHARED, and stays shared: the DATA behind both (the
// `order_cycles.status` / `stage` pair from module 17, `orders.handed_over_at` from
// module 16 — published as `orderHandedOver` by `GET /friends/cycles`) and the
// STATUS-BEFORE-STAGE reading order below. Nothing about the *state machine* is
// re-derived here; only the words differ.
//
// ⚠ DEPENDENCY-FREE, for `lib/cycle-stages.js`'s and `lib/order-lines.js`'s reason:
// this project has no unit runner, so a Playwright spec importing this module with
// plain `node` IS its unit test (`portal-history.spec.js` §1 does exactly that, and
// asserts these six strings are byte-different from all six of 17's — the pin that
// makes the split above a measurement rather than a promise).

/**
 * The six badges, `{ text, tone }`. `tone` is the modifier that follows `badge` in
 * the class list — `''` (neutral), `'acc'` (in progress, accent) or `'ok'` (done) —
 * exactly as 18 §UC-PI-009's table spells it.
 *
 * Frozen for `STEPS`'s reason: one home means a consumer is never one assignment
 * away from re-wording the list for every other consumer too.
 */
export const HISTORY_BADGES = Object.freeze({
  submitted: Object.freeze({ key: 'submitted', text: 'Odoslaná', tone: 'acc' }),
  ordered: Object.freeze({ key: 'ordered', text: 'V pražiarni', tone: '' }),
  arrived: Object.freeze({ key: 'arrived', text: 'Balíme', tone: 'acc' }),
  ready: Object.freeze({ key: 'ready', text: 'Zabalená', tone: 'acc' }),
  handed: Object.freeze({ key: 'handed', text: 'Odovzdaná', tone: 'ok' }),
  completed: Object.freeze({ key: 'completed', text: 'Vyzdvihnuté', tone: 'ok' }),
})

/**
 * The badge for ONE history row, from a `GET /friends/cycles` row (18 §UC-PI-009's
 * table, top to bottom).
 *
 * ⚠ `status` IS CONSULTED BEFORE `stage`, and that order is load-bearing for the
 * reason 17's `stageIndex()` documents at length: CS-T1 measured three admin
 * transitions that leave a `stage` disagreeing with its `status`
 * (`locked(ready) → planned`, `completed(ready) → open`, `completed(ready) → locked`).
 * Reading `stage` first — or letting it override `status` in any single branch —
 * surfaces all three as a wrong badge, with nothing going red anywhere.
 *
 * ⚠ `orderHandedOver` outranks `stage` but NOT `status`: a handed-over bag on a
 * LOCKED round reads „Odovzdaná" (the friend has it; the round is still running),
 * while a COMPLETED round reads „Vyzdvihnuté" whether or not the bag was ticked off
 * — hand-over is stage-3 bookkeeping and „Ukončiť objednávku" is the admin's own
 * statement that the round is over (CLAUDE.md §Money & data: hand-over writes no
 * `order_cycles.status`).
 *
 * Under `locked`, an unknown or NULL `stage` reads as `ordered` — the common case,
 * not the defensive one: §UC-CS-001 forbids a backfill, so every locked round that
 * predates module 17 carries NULL.
 *
 * Anything else — `open`, and any status a round carrying a SUBMITTED order could
 * be moved to by an admin (`planned`, a future value) — is „Odoslaná": the only
 * claim it makes is the one `hasOrder` already guarantees.
 */
export function historyBadge(cycle) {
  if (!cycle || typeof cycle !== 'object') return HISTORY_BADGES.submitted
  switch (cycle.status) {
    case 'completed':
      return HISTORY_BADGES.completed
    case 'locked':
      if (cycle.orderHandedOver) return HISTORY_BADGES.handed
      if (cycle.stage === 'arrived') return HISTORY_BADGES.arrived
      if (cycle.stage === 'ready') return HISTORY_BADGES.ready
      return HISTORY_BADGES.ordered
    default:
      return HISTORY_BADGES.submitted
  }
}
