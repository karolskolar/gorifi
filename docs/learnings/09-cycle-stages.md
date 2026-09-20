# 09 — Cycle stages (module 17)

Per-task lessons for `docs/specification/17-cycle-stages.md`. Read this before touching
`order_cycles`' three new columns, `backend/src/helpers/cycle-stage.js`, the
`POST`/`PATCH /api/cycles` contract, or any surface that renders where a round's coffee is.

---

## CS-T1 — the columns, the helper body, the contract, the payloads (2026-09-20)

**What shipped.** `opens_at` / `closes_at` / `stage` on `order_cycles` (CREATE **and**
ALTER); `helpers/cycle-stage.js` grew `CYCLE_STAGES`, `LOCKED_STAGE_DEFAULT` and the real
`markCycleReady()` body replacing DP-T1's stub; `POST`/`PATCH /api/cycles` validate and
write the dates and couple `stage` to `status`; the three fields ride the friend, public,
guest-listing, guest-status and admin cycle payloads. Backend only — the lib, the
component and the two UI surfaces are CS-T2/T3/T4.

### 1. ⚠ The ALTER placement trap is real, and it is worse than recorded

`schema.js` has a `_check_test` block that recreates `order_cycles` from a **hard-coded
column list** plus an `INSERT ... SELECT` naming the old columns. Any `ADD COLUMN` placed
before it is silently dropped on every database where it fires. The three ALTERs therefore
sit **after** it, and the `CREATE TABLE IF NOT EXISTS` carries the columns too (a fresh
database never trips the block, so the pair is consistent both ways).

⚠ **Found while writing the test, out of scope, recorded here:** that block would also
CRASH on the databases it exists for. Its `INSERT ... SELECT` names `type`, but
`ALTER TABLE order_cycles ADD COLUMN type` lives ~430 lines LATER in the same file. A
database old enough to trip the `status` CHECK is old enough to lack `type`, so the block
throws `no such column: type` from inside a `catch` that has no inner `try` — i.e. the
backend dies at boot. (The recorded `parcel_enabled` / `parcel_fee` omission is the same
family.) Nothing was changed: §UC-CS-001 fences the block off explicitly. The e2e fixture
has to hand the block a `type` column so it can run at all, and says so at the site.

**It is pinned** — `cycle-stages.spec.js` „the three columns SURVIVE the `_check_test`
recreate on a pre-'planned' database" builds an old-schema DB and runs the real migration
in a child process. Mutation-proved: move the ALTERs above the block and that test, and
only that test, reds.

### 2. ⚠ The stub's recorded contract was WRONG, and the spec caught it

DP-T1's header said „set ready only when `stage IN ('ordered','arrived')`". §UC-CS-003
says `WHERE id = ? AND status = 'locked' AND (stage IS NULL OR stage <> 'ready')`. The
difference is every locked cycle in production: the no-backfill rule leaves them at
`stage IS NULL`, which is in **neither** enum set, so the stub's version would have left
exactly those rounds stuck forever. The spec wins; the superseded sentence was rewritten in
the file rather than left contradicting the code.

That row is **unreachable through the API** (locking writes `ordered`, unlocking also
opens the cycle, `stage: null` is a 400), so its test manufactures it with `node:sqlite`
behind a `DB_PATH` skip — the build-the-scenario kind of gate. Mutation-proved: restore the
stub's predicate and that one test reds.

### 3. ⚠ `cycle_stage` is a STRING; the helper returns an OBJECT

§UC-CS-003 specifies `markCycleReady(cycleId) → { changed: boolean }`, but module 16
publishes `cycle_stage: <string|null>` (16 §UC-DP-009) and all three call sites passed the
helper's return value **straight into the response** — which only worked because the stub
returned `null`. A naive fill emits `{"changed":true}` where the contract promises a string.

**Resolution: the helper returns `{ changed, stage }` and the routes read `.stage`.**
`changed` is the spec's field, unchanged in name and meaning; `stage` is additive (the
`PaymentModal` precedent — published shapes GROW, never move). The alternative — three
call sites each re-reading the row after the call — is three copies of the same SELECT,
which is how they start disagreeing; here it also has to happen inside the caller's
transaction. Mutation-proved in two files at once: hand the object to `res.json` and both
`cycle-stages.spec.js` and the shipped `distribution-handover.spec.js:1102` red.

### 4. The shipped `cycle_stage: null` pins were never seam evidence

`distribution-handover.spec.js:1119/:1241/:1690` assert `null`, two of them commented
„CS-T1 fills the body; until then the stub answers null". **The value is still `null`
after CS-T1** — every cycle in that file is `open`, and `markCycleReady()` is a no-op off
`locked`. Only the comments moved; they now pin the no-op rule instead. The promotion
itself had to be proved in a new file, on a locked cycle.

### 5. `markCycleReady()` is deliberately NOT argument-defensive

The stub accepted `undefined` / `{}` because it bound nothing. The real helper binds, so
those shapes throw. Not guarded on purpose: all three call sites pass a `cycle_id` read
from a database row, and swallowing a malformed id would silently skip a promotion instead
of failing loudly. `distribution-foundation.spec.js`'s probe keeps the shapes a caller can
actually produce (an unknown id, `null`) and requires them to be a safe no-op.

### 6. `stage` is NOT read through `bindValue`

`bindValue` answers „can SQLite bind this?"; the question here is the stricter „is it one
of the three enum values?". A non-string shape (`{}`, `true`, `[1]`, `['ready']`, `null`)
fails the `includes()` and lands on the same `400 Neplatná fáza` as `'packed'`. It must
never reach the storage CHECK — mutation-proved: delete the validation and 12 tests red
with 500s plus `SqliteError: CHECK constraint failed: stage IN (…)` in the server log.

The two DATES are the opposite: they DO go through `bindValue`, so the shipped FUP-T13
skip survives (unbindable ⇒ 200, stored value untouched). ⚠ But `bindValue` PASSES a finite
number, so `{ closes_at: 20261003 }` reaches the format check and is a 400 — not a skip.

### 7. The date-order check reads the row AS IT WOULD BE

`closes_at < opens_at` is compared against the row **after** the body is applied, not
against the body alone: editing only the deadline of a cycle that already has an opening
must still be refused. Pinned with a non-vacuity follow-up (the same edit one day later
must pass), so the test cannot also be green for a route that refuses every `closes_at`.

### 8. The 409 is checked FIRST

`{ status: 'open', stage: 'arrived' }` on a locked cycle is `409 not_locked` and writes
**nothing** — not the status either. The effective status is `body.status ?? cycle.status`,
so `{ status: 'locked', stage: 'ready' }` legitimately locks straight into `ready`.

### 9. What the seam does NOT do

`status` is never written (no auto-complete — the admin's „Ukončiť objednávku" stays the
only writer of `completed`); no `transactions` row (hand-over is ledger-neutral, `packed`
is the money moment); un-hand-over calls nothing here, and its response carries
`cycle_stage: null` **by contract** — the claim „the stage survives a reversal" is about
the ROW, and a test that asserts it on the response field is asserting the wrong thing.

### 10. ⚠ THREE stale-/reset-stage transitions, all invisible only because `status` wins

CS-T1 ships the status↔stage coupling §UC-CS-002 specifies, and that specification names
only three transitions: lock ⇒ `ordered`, unlock (`locked → open`) ⇒ NULL, `completed`
leaves the stage alone. Everything else falls through with no stage write, and two
transitions the spec never names leave a cycle whose `stage` disagrees with its `status`.
**Measured against the running server, not inferred** (2026-09-20):

| # | Transition | Result | Why it falls through |
|---|---|---|---|
| A | `locked(ready) → planned` | `status=planned`, **`stage=ready`** | §UC-CS-002: „`planned` — unchanged from today, no stage semantics" |
| B | `completed(ready) → open` | `status=open`, **`stage=ready`** | the unlock branch is gated on `cycle.status === 'locked'`, so it never fires from `completed` |
| C | `completed(ready) → locked` | `status=locked`, **`stage=ordered`** | the lock branch is `cycle.status !== 'locked'`, so re-locking a finished round for a hand-over correction RESETS it |

**C is the one that is not merely stale.** A and B leave a value nobody reads; C actively
walks the friend-facing timeline **backwards from step 5 (`Zabalené, rozvážame`) to step 2
(`Objednávky uzavreté…`)** on a round whose coffee has already been handed out. The admin's
recovery path for a mis-completed cycle is exactly `completed → locked`.

**Why nothing is broken today, and what that costs CS-T2.** All three are invisible because
§UC-CS-005 `stageIndex()` consults `status` FIRST and only falls through to `stage` under
`locked` — so A and B render from `planned`/`open` and never read the stale value, and C
renders step 2 for a cycle that genuinely is locked again. ⚠ **That ordering is therefore
not a stylistic preference, it is the only thing keeping these three out of the UI.** If
`stageIndex()` ever consults `stage` before `status`, all three surface at once and
**nothing reds** — no test pins any of them, in this row or any other.

**Deliberately NOT fixed in CS-T1.** The spec does not name these transitions, and widening
a backend contract inside a row whose scope is the columns + the seam is how a contract
stops matching its spec. The options when someone does pick this up, in preference order:
(1) clear `stage` on every transition OUT of `locked` rather than on `open` alone, and make
the lock branch `cycle.status === 'open'` rather than `!== 'locked'` — narrow, and it makes
the column mean what its name says; (2) leave it and pin the `status`-first rule with a test
so CS-T2 cannot silently invert it. ⚠ Whoever does (1) must re-read §UC-CS-002's
„`completed` — stage untouched, it is the historical record" line first: A and B are that
same principle leaking one transition too far, and C contradicts it outright.
