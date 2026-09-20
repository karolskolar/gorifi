// Cycle stage seam (DP-T1, 16 §UC-DP-009).
//
// ⚠ THIS FILE IS A DELIBERATE PLACEHOLDER. `markCycleReady()` below is a NO-OP
// STUB with no body and no database access, and it exists so module 16's
// hand-over routes (DP-T3 `PATCH …/handed-over`, DP-T4 the bulk route) can call
// the hook and echo its result as `cycle_stage` from the day they ship, months
// before the stage model exists.
//
// ⚠ ITS SUCCESSOR IS **CS-T1** (module 17, `docs/specification/17-cycle-stages.md`,
// §UC-CS-001/002 — "`markCycleReady()` BODY replacing DP-T1's stub"). CS-T1
// replaces ONLY this symbol; it adds `CYCLE_STAGES` and `LOCKED_STAGE_DEFAULT`
// beside it and adds `opens_at` / `closes_at` / `stage` to `order_cycles`. Nothing
// else in this file is load-bearing.
//
// The contract CS-T1 implements, recorded here so the seam connects (and NOT
// specified by module 16):
//   - set `stage = 'ready'` only when `status = 'locked'` and
//     `stage IN ('ordered','arrived')`;
//   - NEVER touch `order_cycles.status` — completion is the admin's button
//     (§UC-DP-014), and no hand-over path may write it;
//   - idempotent and forward-only: reversing a hand-over does NOT demote;
//   - synchronous (it runs INSIDE the caller's `db.transaction()`, and an `await`
//     in there would break the `instances: 1` atomicity the whole app relies on).

/**
 * Promote a cycle to the `ready` stage on its first hand-over.
 *
 * STUB: does nothing and returns `null`. Until module 17 ships there is no
 * `order_cycles.stage` column to write, so every caller's response echoes
 * `cycle_stage: null` (§UC-DP-009 acceptance criterion).
 *
 * @param {number} _cycleId the cycle the hand-over belongs to — accepted so the
 *   call sites are already correct; unused until CS-T1 supplies the body.
 * @returns {null} always, today.
 */
export function markCycleReady(_cycleId) {
  return null;
}
