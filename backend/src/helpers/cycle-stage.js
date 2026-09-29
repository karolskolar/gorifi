import db from '../db/schema.js';

// The cycle STAGE model — module 17's one home (17 §UC-CS-002 / §UC-CS-003).
//
// `order_cycles.stage` answers the friend's „kde je moja káva" while the cycle is
// LOCKED: `ordered` → `arrived` → `ready`. It is meaningful ONLY under
// `status = 'locked'` (NULL on every other status), the admin writes it through
// `PATCH /api/cycles/:id`, and exactly ONE transition is automatic — the first
// hand-over promotes the cycle to `ready` (§11 of the roadmap, §UC-CS-003).
//
// ⚠ THIS FILE SHIPPED IN DP-T1 AS A NO-OP STUB so module 16's hand-over routes
// could call the hook and echo `cycle_stage` from the day they shipped. CS-T1
// (this change) supplies the body. ⚠ THE STUB'S RECORDED CONTRACT SAID
// „set ready only when stage IN ('ordered','arrived')" — **that claim is
// SUPERSEDED and was wrong**: it would leave every PRE-MODULE locked cycle (which
// is every locked cycle in production, because §UC-CS-001 forbids a backfill)
// stuck at NULL forever, since NULL is in neither set. §UC-CS-003 pins the
// predicate below — `stage IS NULL OR stage <> 'ready'` — and its acceptance
// criteria require exactly that row to promote. The spec wins; the old sentence is
// rewritten here rather than left contradicting the code (CLAUDE.md
// §Documentation discipline).

/** The only three values `order_cycles.stage` may hold. Mirrored by the CHECK
 *  constraint in `db/schema.js` and validated by `PATCH /api/cycles/:id` BEFORE
 *  any write — a `SQLITE_CONSTRAINT_CHECK` throw would be a 500, never an answer
 *  to a malformed body. The route, the helper and the constraint never disagree
 *  because this array is the one home for all three. */
export const CYCLE_STAGES = ['ordered', 'arrived', 'ready'];

/** The stage a cycle enters when the admin LOCKS it (`status: 'open' →
 *  'locked'`), written in the same UPDATE as the status. */
export const LOCKED_STAGE_DEFAULT = 'ordered';

/**
 * Promote a cycle to the `ready` stage on its first hand-over (§UC-CS-003).
 *
 * ⚠ SYNCHRONOUS, and it runs INSIDE the caller's `db.transaction()` — the stage
 * and the hand-over commit or roll back together. An `await` anywhere in that
 * chain would break the check-then-write atomicity the whole app rests on
 * (`instances: 1` + synchronous handlers, CLAUDE.md §Hard rules).
 *
 * The rules the single UPDATE encodes, each of them load-bearing:
 *   - **`status = 'locked'` only.** A hand-over on an OPEN cycle (the board has no
 *     cycle-status gate) or on a COMPLETED one (16's mis-click recovery) leaves
 *     `stage` exactly as it was — for an open cycle that means NULL, and that is
 *     the right answer, not a missing feature.
 *   - **⚠ `stage IS NULL` counts.** Every locked cycle that predates module 17 has
 *     a NULL stage and is never backfilled (§UC-CS-001), so a predicate written as
 *     `stage IN ('ordered','arrived')` would refuse to promote precisely those
 *     rows. See the superseded note at the top of this file.
 *   - **Idempotent and forward-only.** A second hand-over reports `changed: false`
 *     and writes nothing; nothing here ever writes `arrived` or `ordered`, and
 *     un-handing a bag calls nothing here at all (the admin corrects a stage by
 *     hand through the PATCH).
 *   - **⚠ `order_cycles.status` is NEVER touched.** No auto-complete (roadmap
 *     §16 Q8.c): the admin's „Ukončiť objednávku" button is the only way a cycle
 *     becomes `completed`. Hand-over is also LEDGER-NEUTRAL — `packed` is the money
 *     moment — and nothing here writes a `transactions` row.
 *
 * @param {number} cycleId the cycle the handed-over bag belongs to.
 * @returns {{ changed: boolean, stage: string|null }} `changed` is §UC-CS-003's
 *   field — true exactly when THIS call wrote the row. `stage` is the cycle's
 *   stage AFTER the call, read UNCONDITIONALLY — so it is `null` only for an OPEN or
 *   PLANNED cycle and for an id that resolves to no row. ⚠ A COMPLETED cycle carrying
 *   a stage reports THAT stage (`{ changed: false, stage: 'arrived' }`), not `null`:
 *   the promotion is refused but the value is still the truth about the row. That is
 *   deliberate and pinned — see the `status = 'locked' only` bullet above. It is what
 *   module 16's three hand-over responses
 *   publish as `cycle_stage: <string|null>` (16 §UC-DP-009). It is read here, in
 *   the same transaction, rather than re-queried at three call sites — the reason
 *   is the usual one: three copies is how they start disagreeing.
 */
export function markCycleReady(cycleId) {
  const written = db.prepare(`
    UPDATE order_cycles
       SET stage = 'ready'
     WHERE id = ?
       AND status = 'locked'
       AND (stage IS NULL OR stage <> 'ready')
  `).run(cycleId);

  const row = db.prepare('SELECT stage FROM order_cycles WHERE id = ?').get(cycleId);

  return { changed: written.changes === 1, stage: row ? row.stage : null };
}
