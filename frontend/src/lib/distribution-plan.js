// ── DP-T8 (16 §UC-DP-014) — the ONE HOME of the cycle header's plan sentence ──
//
// Two views render the same header: `CycleDetail.vue` (the admin's cycle page) and
// `Distribution.vue` (the board). Module 17's stage controls will share it too. So
// the two rules below live here rather than in either view — this session has spent
// three rows re-homing exactly this shape (`helpers/payment.js`, `helpers/delivery.js`,
// and FUP-T24 is still open on the kg rule, which has four copies and no address).
//
// ⚠ NEITHER FUNCTION DERIVES ANYTHING. `plan[]` and `totals` come from
// `GET /cycles/:id/distribution` (DP-T2), whose classification is
// `backend/src/helpers/delivery.js` — the one home of "which target is this party
// on". Everything here is presentation.

/**
 * „Packeta 3 · Kaviareň Ruža 5 · Osobne 4 — 3/12 odovzdaných"
 *
 * ⚠ ZERO-COUNT TARGETS ARE OMITTED, which is the one place this line differs from
 * the board's plan CARDS (§UC-DP-014 against §UC-DP-010 item 3), and deliberately:
 * an active pickup point with nobody on it is information while PLANNING („that
 * place is set up, nobody is going there") and noise in a one-line summary of a
 * round that is already packed.
 *
 * Returns '' when there is nothing to say — no totals (the fetch failed or the
 * cycle is still open) or no bags at all. The caller renders nothing rather than a
 * half sentence.
 */
export function planLineText(plan, totals) {
  const count = Number(totals?.count) || 0
  if (!count) return ''
  const parts = (Array.isArray(plan) ? plan : [])
    .filter((entry) => Number(entry?.count) > 0)
    .map((entry) => `${entry.target_label || ''} ${entry.count}`.trim())
  if (parts.length === 0) return ''
  const handed = Number(totals?.handed_count) || 0
  return `${parts.join(' · ')} — ${handed}/${count} odovzdaných`
}

/**
 * The „Ukončiť objednávku" gate: every party handed over, and at least one party.
 *
 * ⚠ IT IS THE INTERFACE'S GATE ONLY (PO decision 2026-09-19, §UC-DP-014). The
 * server keeps accepting `PATCH /cycles/:id { status: 'completed' }` whatever the
 * hand-over state, because a bag that will never be collected must not be able to
 * hold a round open for ever. `distribution-board.spec.js` asserts BOTH halves —
 * the disabled button AND the API that still completes — so that the 409 which
 * looks so obviously right is not added silently later.
 */
export function allPartiesHandedOver(totals) {
  const count = Number(totals?.count) || 0
  return count > 0 && Number(totals?.handed_count) === count
}
