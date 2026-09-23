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

That row is ~~**unreachable through the API**~~ (locking writes `ordered`, unlocking also
opens the cycle, `stage: null` is a 400) — ⚠ **SUPERSEDED by FUP-T26, 2026-09-20: the lock
default fires from `open` only, so `PATCH { status: 'locked' }` on a PLANNED cycle now
produces exactly this row.** The test still manufactures it with `node:sqlite`
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
| C | ~~`completed(ready) → locked`~~ | ~~`status=locked`, **`stage=ordered`**~~ | ~~the lock branch is `cycle.status !== 'locked'`~~ |
| D | `locked(ready) → planned → open` | `status=open`, **`stage=ready`** | ⚠ **COMPOSES FOR FREE out of A, found in the FUP-T26 review.** Neither hop writes `stage`: A leaves it (planned has no stage semantics) and the unlock branch never fires because the cycle is `planned`, not `locked`. Same class as B, equally invisible (`stageIndex` returns 1 off `status`), equally unpinned. **While A stays unfixed this path stays reachable** — so „two stale transitions" is really „two, plus anything they compose into". If A or B is ever revisited, enumerate the COMPOSITIONS, not just the single hops. |

⚠ **Row C is FIXED — FUP-T26, 2026-09-20.** The lock branch is now
`cycle.status === 'open'`, exactly the scope §UC-CS-002's own parenthetical gives it, so
`completed(ready) → locked` keeps `ready` and the recovery path no longer rewinds anything.
`planned → locked` narrowed with it and now writes no stage at all (NULL, which every
reader maps to `ordered`). **A and B are spec-CONFORMANT and were deliberately left
standing**, and both are now pinned server-side as such. The table below still describes
A and B; read C as history. Full write-up: §FUP-T26 at the end of this file.

~~**C is the one that is not merely stale.**~~ (FIXED, FUP-T26 — kept because it is why the
row existed.) A and B leave a value nobody reads; C actively
walks the friend-facing timeline **backwards from step 5 (`Zabalené, rozvážame`) to step 2
(`Objednávky uzavreté…`)** on a round whose coffee has already been handed out. The admin's
recovery path for a mis-completed cycle is exactly `completed → locked`.

**Why nothing is broken today, and what that costs CS-T2.** All three are invisible because
§UC-CS-005 `stageIndex()` consults `status` FIRST and only falls through to `stage` under
`locked` — so A and B render from `planned`/`open` and never read the stale value, and C
renders step 2 for a cycle that genuinely is locked again. ⚠ **That ordering is therefore
not a stylistic preference, it is the only thing keeping these three out of the UI.** If
`stageIndex()` ever consults `stage` before `status`, all three surface at once ~~and
**nothing reds** — no test pins any of them, in this row or any other~~ — **the „nothing
reds" half is SUPERSEDED by CS-T2 (2026-09-20): see §CS-T2 item 1.** Inverting `stageIndex()`
now reds one purpose-built test. ⚠ ~~The rest of the paragraph stands, and the distinction
matters: the three BACKEND transitions are still unpinned server-side — nothing stops the
routes from writing the disagreeing value.~~ **SUPERSEDED by FUP-T26 (2026-09-20): all
three are pinned server-side now** — C as the FIXED behaviour, A and B as deliberate
fall-throughs (`cycle-stages.spec.js`, the `FUP-T26 · 17 §UC-CS-002` describe, which drives
the real PATCH and reads the row back). What CS-T2 pinned is only that the FRONTEND keeps
reading `status` first, and that is still the only thing keeping A and B off a screen.
⚠⚠ And the obvious test does NOT catch it: every row of §UC-CS-005's
seven-row acceptance table pairs a stage that agrees with its status, so a stage-first read
is a fixed point of all seven. Only the dedicated test discriminates.

**Deliberately NOT fixed in CS-T1** (and picked up by FUP-T26, which took option (1)'s
SECOND half only — see that section for why the first half would have been a spec
deviation of its own). The spec does not name these transitions, and widening
a backend contract inside a row whose scope is the columns + the seam is how a contract
stops matching its spec. The options when someone does pick this up, in preference order:
(1) clear `stage` on every transition OUT of `locked` rather than on `open` alone, and make
the lock branch `cycle.status === 'open'` rather than `!== 'locked'` — narrow, and it makes
the column mean what its name says; (2) leave it and pin the `status`-first rule with a test
so CS-T2 cannot silently invert it. ⚠ Whoever does (1) must re-read §UC-CS-002's
„`completed` — stage untouched, it is the historical record" line first: A and B are that
same principle leaking one transition too far, and C contradicts it outright.

---

## CS-T2 — the lib, the two declensions, the component (2026-09-20)

**What shipped.** `frontend/src/lib/cycle-stages.js` (six `STEPS` + `stageIndex`,
`timelineSteps`, `fmtDay`, `daysUntil`, `inWeeksText`, `nextOpeningText`,
`openUntilText`, `currentCycleFor`); `lib/plural.js` gained `daysLabel` / `weeksLabel`;
`components/CycleTimeline.vue` — ONE component, `vertical` + `compact`. ~~Nothing mounts it
yet:~~ **superseded — CS-T3 mounted it (admin header, `compact`); see §CS-T3 below.** CS-T4
still owns the guest status page and the first `vertical` render.

### 1. §10's warning was worth the paragraph — and the mutation proves it silently

Inverting `stageIndex()` to read `stage` before `status` reds **exactly one** test
(„⚠ `status` is consulted BEFORE `stage`…"). The seven-row `stageIndex` table test stays
GREEN under that mutation, because every row in it has a `stage` that agrees with its
`status`. That is the fixed-point trap in miniature: the obvious table proves nothing about
the ordering, and without the dedicated test the three defects CS-T1 measured would have
reached the friend with a fully green suite. The dedicated test therefore asserts, per row,
both the index AND `not.toBe()` the index the stale value would have produced.

### 2. ⚠ §UC-CS-009's sweep regex does not do what it says

`/kol[oáa]\b|cykl/i` **does not match „kolá"**: `á` is outside ASCII `\w`, so the trailing
`\b` never fires after it. A ban that misses one of the four words it names is the one
failure mode a ban cannot have. It also matches „okolo", which is module 18's own copy
(„Káva príde okolo {expected_date}", PO decision O2) — a false positive waiting for the
first consumer to reuse the sweep. Shipped as **`/\bkol[oáa]|cykl/iu`** (~~current~~ — superseded
by PI-T11's `e2e/helpers/vocabulary.js BANNED`, which this one missed „kole"/„kolu" against), and the spec file
carries a test that runs the regex over a bad list AND a good list, so the regex itself is
evidence rather than faith. ~~Spec text not edited (copy/regex text is the PO's)~~ —
**the spec WAS edited, by the orchestrator, at `17-cycle-stages.md:537`**: the broken regex
is struck in place with the working one beside it. The reasoning that it was „the PO's" does
not apply — the six LABELS are PO copy, but a verification regex in §UC-CS-009 is a test
instruction, and leaving a broken one there hands it to CS-T4's closeout sweep. ⚠ Precision:
the LEADING `\b` is the whole fix; the `u` flag is cosmetic.

### 3. ⚠ `new Date('2026-02-31T00:00:00')` is 3 MARCH, not Invalid Date

V8 falls back to lenient parsing for out-of-range days, so a shape-only `^\d{4}-\d{2}-\d{2}$`
check would have printed „3. marca" for a date nobody chose. `fmtDay` and `daysUntil` both
follow the regex with the same UTC round-trip the route uses. The refusal test carries its
own non-vacuity line — `fmtDay('2026-03-03') === '3. marca'` — so the empty string is a
refusal and not a broken formatter.

Display uses LOCAL midnight (`T00:00:00`), validation uses UTC (`T00:00:00Z`). Formatting the
UTC instant instead reds the `fmtDay` test only under a negative-offset zone, so that
assertion runs inside `withTz('America/New_York', …)`.

### 4. ⚠ A DST assertion on a UTC box is a fixed point

The first version of „`daysUntil` counts whole CALENDAR days" **passed unchanged** when the
implementation was mutated to naive local-time subtraction — this box runs UTC, where the two
are identical. The fix is `withTz('Europe/Bratislava', …)` around the boundary assertions
(`process.env.TZ` is re-read per `Date`, so a worker can switch zones mid-test). With the zone
switched, the same mutation reds. Any future date arithmetic here needs the same treatment:
**a timezone assertion that does not name a timezone is measuring nothing.**

### 5. The component has no rendered coverage in this row, deliberately

~~CS-T2 ships `CycleTimeline.vue` and mounts it nowhere, so §UC-CS-009 item 1's rendered
`done`/`now`/`next` counts and the computed `.mk` border belong to CS-T3/CS-T4.~~
**SUPERSEDED — CS-T3 mounted it and delivered the rendered half on `.d`; the `.mk` half is
UNREACHABLE as written (see §CS-T3).** What IS
provable now is the set nobody later would notice breaking, and it is pinned at source level
by compiling the SFC with `@vue/compiler-sfc` out of `frontend/node_modules`:

- it parses / the template compiles / the scoped CSS compiles (a missing end tag reds it);
- exactly one `<style scoped>` block, and the COMPILED css — comments stripped first, because
  the port's header names `.app` in order to say the prefix was dropped — contains no `.app`
  and no `.modal-layer`;
- every `var(--…)` has a fallback, gated on `≥ 10` tokens so a component that stopped theming
  itself could not pass;
- no `position: fixed|sticky`, no `z-index`, exactly ONE `position: absolute` (the `.st::before`
  connector, whose containing block is `.st`) — i.e. nothing that the `.app > *` cascade rule
  could silently flatten;
- none of the six labels appears in the SFC (the only Slovak it owns is „Krok ");
- the ported numbers from `portal2.css:22-42` (13/28 px connector, 28 px marker, 20 px `now`
  label, 11.5 px `when`, 22 px dots, the two rgba rules).

### 6. The `steps` prop is the module-18 seam, and `desc` is why it exists

`timelineSteps()` returns `desc: ''` for all six (resolved conflict 8). A consumer that wants
the prototype's sentences passes its own array through `steps` — which keeps the LABELS in the
lib while letting 18 own its copy. `aria-label` and the `now` index are derived from whatever
array is in play, so an injected array of a different length still labels correctly.

### 7. Deviations from the spec text, all deliberate

- The sweep regex (§2 above).
- `nextOpeningText` branch 1 is gated on `fmtDay()` returning something, not on the raw
  `opens_at`: a malformed date falls through to `plan_note`/the fallback instead of composing
  „…približne ." with a hole in it. `openUntilText` does the same.
- `inWeeksText(iso, today)` takes `today` explicitly (the spec writes `inWeeksText(opens_at)`
  inside `nextOpeningText`); without it the whole section would be a function of the clock.
- `.cs-tl .bd` adds `overflow-wrap: anywhere` to the prototype's inline `minWidth: 0`
  (CLAUDE.md: `min-w-0` is not `overflow-wrap`).
- `currentCycleFor`'s `console.warn` is English: it is a developer diagnostic, not user copy,
  and the rendered-copy sweep never sees it.
- ⚠ **A FIFTH deviation, found in review and missing from this list when it was written:**
  `openUntilText` does **not** fall back to `expected_date` when `closes_at` is NULL — it
  returns the bare „Objednávky otvorené". §UC-CS-005's PO-O2 banner (`17-cycle-stages.md:284`)
  says the copy helpers do fall back. The SHIPPED behaviour is the right one, and module 18 is
  why: `18-portal-information-architecture.md:356-360` specifies „`closes_at` null ⇒
  **Objednávky sú otvorené.**" with „Káva príde okolo {expected_date}" as a SEPARATE clause,
  omitted independently when `expected_date` is null. The deadline sentence and the delivery
  sentence are two facts, and folding `expected_date` in here would make this lib a second
  home for a string module 18 owns. **PI-T1/PI-T3 must compose the two clauses at the call
  site; do not grow the fallback into this helper.**

---

## CS-T3 — the admin controls, and the component's first mount anywhere (2026-09-20)

**What shipped.** `CycleDetail.vue` only: two `type="date"` controls (Otvorenie
objednávok / Uzávierka objednávok) on the cycle settings card, a stage `Badge` and the
two forward-only buttons („Káva dorazila" / „Zabalené, rozvážame") in the header, and
`<CycleTimeline :cycle="cycle" variant="compact" />` with a muted caption line beside
DP-T8's plan line. No backend change, no schema change, no new dependency.
`AdminDashboard.vue` is untouched (PO O5).

### 1. ⚠ `saveExpectedDate()` is the pattern, and it does NOT snap back

The spec says to follow `saveExpectedDate()` (`CycleDetail.vue:1149`) and, three lines
later, that a 400 must leave the control showing the STORED value. Those two
instructions contradict each other: that function's `await loadAll()` sits INSIDE the
`try`, after the call that throws, so a refused `expected_date` keeps standing in its
input. The two new savers put the refetch in `finally` instead — it runs on both paths,
and `loadAll()` does not clear `error`, so the banner explaining the refusal outlives
the reload that undoes it. Mutation-proved in both directions: move the refetch back
into the `try` and „⚠ a refused pair shows the server message and the control SNAPS
BACK" reds on the input value, with the rest of the file green.

⚠ `expected_date` and `plan_note` were deliberately left on the old behaviour. They are
out of scope (PO O2, resolved conflict 6) and changing them would move an assertion
nobody asked to move; the divergence is recorded here so the next reader does not
"fix" the new savers back into the old shape.

### 2. ⚠ The admin skin renamed the colliding tokens years ago, and that is why this works

`CycleTimeline.vue`'s port reads `--nb-ink`, `--accent`, `--accent-ink`, `--ink-dim`,
`--ink-faint`, `--font-mono`, `--font-display`, each behind a fallback. shadcn's
`style.css` defines `--accent` and `--border` in `:root` in EVERY other project; this
one calls them `--ui-accent` / `--ui-border`. Had it not, `background: var(--accent,
#ff2d87)` on the admin page would have resolved to the HSL TRIPLET `60 5% 96%` —
invalid at computed-value time, i.e. a transparent dot, and the fallback would never
have fired. The component is safe here by an accident of someone else's naming, so the
test asserts the PRECONDITION (`--nb-ink` / `--accent` / `--ink-dim` all empty on
`document.documentElement`, and zero `.app` / `.modal-layer` elements on the page)
before it asserts a single computed value. Without those two lines the whole test would
be just as green on a page that DID supply the tokens.

Measured mutation (drop the fallback from `.cs-dots .d`):
`3px solid rgb(10, 10, 10)` → **`0px none rgb(28, 25, 23)`** — the entire `border`
shorthand is dropped and the colour falls through to the plate's `currentColor`. That
is the whole reason CS-T2 built the component with fallbacks, now measured rather than
argued.

⚠ **The `.mk` in §UC-CS-009 item 1 is not reachable from this row.** `.mk` is the
VERTICAL variant's marker; §UC-CS-007 mounts `variant="compact"`, whose marker is `.d`.
The two carry the same `3px solid var(--nb-ink, …)` declaration, so the claim is
delivered on `.d`, and the first `.mk` render belongs to CS-T4's guest status card.

⚠⚠ **BUT CS-T4 CANNOT INHERIT THE FALLBACK CLAIM, AND THIS IS THE FIFTH CAN'T-FAIL
ASSERTION THIS MODULE HAS PRODUCED — CAUGHT BEFORE IT WAS WRITTEN** (CS-T3 review,
2026-09-20). `GuestOrderStatus.vue`'s root is `<div class="app flex flex-col">`, and
`friends-theme.css` defines `--nb-ink:#0a0a0a` on `.app` — **byte-identical to the
component's own fallback**. A CS-T4 test that reads `getComputedStyle('.mk').borderTopColor`
there gets `rgb(10, 10, 10)` whether the fallback exists or not: delete every `, #0a0a0a`
in the SFC and it still passes. The `.app` ancestor is exactly what makes the reading
meaningless, and it is unavoidable on that page.

**So: CS-T3's `.d` measurement is module 17's ONLY runtime proof of the fallback
mechanism** — the admin page is the only place the component renders where the portal
tokens are genuinely absent (`style.css` defines `--ui-accent`/`--ui-border`, and neither
`--accent` nor `--nb-ink` nor `--ink-dim`). Per-declaration fallback COVERAGE is CS-T2's
source gate (`cycle-stages.spec.js`, the `bare` array must be `[]`), not a second
computed-style test. CS-T4 should pin the vertical variant's `done`/`now`/`next` COUNTS and
its label — which are real there — and must not add a fallback assertion on that page.
Same for "the vertical variant's done/now/next counts" in that item — the counts are
pinned here on the compact strip (which has no `done` class: a dot with neither `now`
nor `next` IS done), and the vertical ones are CS-T4's.

### 3. ⚠ The six-row index table is only evidence because the `completed` row is stale

The acceptance criterion names four indices (planned 0, open 1, locked+ready 4,
completed 5). Four rows whose statuses each map to their own index prove that
`stageIndex` was called — not that it reads `status` before `stage`, which is the one
property CS-T1 §10 and CS-T2 §1 say is load-bearing. The table here is six rows, all
six indices distinct, and the `completed` fixture is built through **lock → stage
`ready` → complete**, so it carries a STALE `stage = 'ready'` (§UC-CS-002: `completed`
leaves the stage alone, it is the historical record). Invert `stageIndex()` and that
row — and only that row — reds, at step 4 instead of 5. The other five are fixed points
of the inversion, exactly as CS-T2 warned. The test says so at the fixture and repeats
the discriminating assertion alone afterwards, so the failure message names the defect
rather than a deep-equality diff.

### 4. The NULL-stage row needed a UI twin, and it is DB_PATH-gated

`canMarkArrived` is `stage === null || stage === 'ordered'`. Drop the NULL half and
every locked round **in production** loses its „Káva dorazila" button, because the
no-backfill rule left them all at NULL — ~~and no sequence of API calls reproduces that
row (locking writes `ordered`, unlocking also opens the cycle, `stage: null` is a 400)~~
**— FALSIFIED by FUP-T26 (2026-09-20): `planned → locked` now writes no stage, so the API
reaches that row directly. See §FUP-T26.**
So the UI test manufactures it with `node:sqlite`, the BUILD-THE-SCENARIO kind of gate,
and `e2e/README.md`'s DB_PATH inventory went from THREE un-skipped tests in this file
to FOUR. Mutation-proved: drop the NULL branch and that test alone reds.

### 5. The header is shared, and the proof is that the plan line comes back byte-identical

DP-T8's `cycle-plan-line` renders for `locked` and `completed` rounds in the same
header block. The stage badge went into a flex row beside the status badge and the
timeline under the plan line. The sharing test captures the plan sentence, clicks
„Káva dorazila" (which re-runs `loadAll()`, and with it `loadDistributionPlan()`), and
requires the same string back — so "does not re-derive its numbers" is asserted as an
invariant across a reload rather than as a grep. Mutation-proved by deleting the `<p>`.

### 6. Small things measured rather than assumed

- The compact strip's connectors are `flex: 1`, so a shrink-to-fit container collapses
  them to zero and prints six touching squares. The plate is `w-64 max-w-full`.
- Chromium serialises `box-shadow` with the spread: `rgb(10, 10, 10) 2px 2px 0px 0px`,
  not `… 0px`. The first version of that assertion failed on the trailing `0px`.
- The header plate is `bg-background text-foreground` because the header itself is
  `bg-primary`; the ported component draws ink on white. That is also what makes the
  fallback mutation VISIBLE — `currentColor` there is `rgb(28, 25, 23)`, not the ink.
- `Input.vue` has no `inheritAttrs: false`, so `type="date"` falls through. No wrapper
  was needed and none was added.
- ⚠ **Process, not code:** `git checkout -- <file>` to revert a MUTATION also reverts
  the uncommitted task work in that file. It cost a full re-application of this row's
  `CycleDetail.vue` diff mid-gate. Keep a pristine copy in the scratchpad and restore
  from that; `git checkout` is safe only for files the row does not touch.

---

## CS-T4 — the guest status card, the copy retarget, the module closeout (2026-09-20)

**What shipped.** `GuestOrderStatus.vue` only: a „Kde je vaša káva" `div.card`
(`data-testid="guest-timeline-card"`) after the `status-paid`/`status-delivered`
pill row carrying `<CycleTimeline :cycle="cycle" />` — the module's FIRST
`variant="vertical"` render anywhere — plus the `readOnlyReason` retarget. Tests:
a CS-T4 section in `cycle-stages.spec.js`, the sanctioned
`guest-status-shell.spec.js:356` edit, and three new rows in the FUP-T13 sweep
(`nonstring-body-shape.spec.js`). No backend change, no schema change, no new
dependency. Module 17 is closed.

### 1. ⚠ THE SIXTH CAN'T-FAIL ASSERTION WAS NOT WRITTEN, BECAUSE CS-T3 PREDICTED IT

§UC-CS-009 item 1 asks for the `.mk` border read out of `getComputedStyle`. On this
page it CANNOT FAIL: `GuestOrderStatus.vue`'s root is `<div class="app …">`, and
`friends-theme.css` sets `--nb-ink:#0a0a0a` on `.app` — byte-identical to the
component's own fallback, so `rgb(10, 10, 10)` comes back whether or not the
fallback exists. CS-T3 wrote that down before CS-T4 opened, the spec was amended,
and the assertion was never written. What this row pins instead is what the `.app`
ancestor cannot fake: the vertical variant's `done`/`now`/`next` STATE VECTOR, the
`now` key + label, and the `when` line. **CS-T3's `.d` measurement on the admin page
remains module 17's only runtime proof of the fallback mechanism.** Per-declaration
fallback COVERAGE stays CS-T2's source gate (the `bare` array must be `[]`).

The general shape, five times over in this module: *an assertion whose expected
value is also produced by the environment it runs in proves nothing.* Ask what
value would make it pass for the wrong reason BEFORE writing it.

### 2. ⚠ TWO stage fixtures, one step apart, because ONE is a fixed point

`locked+ready` (index 4) and `locked+arrived` (index 3) produce different vectors,
different `now` keys and different labels. A component that rendered a FIXED index —
or a page that passed a stale/ignored `cycle` — satisfies at most one of them. With a
single fixture, `:cycle="null"` (index 0) would have been the only mutation caught.
Measured: `:cycle="null"` reds three CS-T4 tests plus the source pin; nothing else in
the suite notices.

Beside the counts, `steps.map(key)` is asserted against the six spec keys in order —
a component rendering ONE step six times satisfies every count on its own.

### 3. The `when` line is the only assertion that proves the WIRING

`status`/`stage` could in principle come from a default. „do 10. októbra" on step 1
exists only if the cycle OBJECT the guest payload publishes reached the component and
was formatted by the lib. Mutation-proved: `closes_at: null` in `routes/guest.js`'s
two status blocks reds that test and the `arrived` one, and nothing else in CS-T4.

### 4. `textContent`, not `innerText`, in the step reader

`.st.now .lbl` and `.when` are `text-transform: uppercase` in the port, and
`innerText` APPLIES that (the standing CLAUDE.md trap). A reader built on `innerText`
would have to compare labels in a casing the lib never produced — i.e. it would be
asserting this component's CSS rather than the step model. `verticalSteps()` reads
`textContent`.

⚠ The RENDERED-COPY sweep is the opposite case and must stay on `innerText`:
`e2e/helpers/copy-sweep.js` reads the page as a human sees it, so a re-introduced
„kolá" in the uppercased card label arrives as „KOLÁ" — caught only because the ban
is case-insensitive. Measured, as a mutation.

### 5. The vocabulary ban has ONE regex home now

~~`BANNED = /\bkol[oáa]|cykl/iu` moved from inside CS-T2's describe to module scope in
`cycle-stages.spec.js`~~ **— SUPERSEDED by PI-T11 (learnings 10 §PI-T11 §1): the one home is
now `e2e/helpers/vocabulary.js BANNED`, a union regex that also catches „kole"/„kolu"/„kolám"/
„kolami"/„kôl"; `cycle-stages.spec.js` imports it.** It first moved to module scope because CS-T4 sweeps the rendered guest page with the same
ban. Two copies of a ban is how the two halves start banning different words; the
shipped „the regex itself catches what it claims to catch" test is now the single
proof for both readers.

### 6. ⚠ The retarget had two decoys next to it, and a blanket replace breaks one

- `catalog-import.spec.js:558` — „Produkt už v tomto cykle existuje." is ADMIN copy;
  „cyklus" is legitimate there (00-overview glossary). A repo-wide substitution
  breaks it.
- `cycle-stages.spec.js:1299` — the OLD sentence is a deliberate BAD fixture proving
  the ban catches it. It is a test fixture, not app copy, and stays valid afterwards.
- ⚠ **A THIRD one is left standing on purpose and is worth a decision later:**
  `backend/src/routes/guest.js:216` answers a 409 with „Objednávanie v tomto cykle je
  už uzavreté." — a genuinely GUEST-FACING string with „cykle" in it. §UC-CS-008
  sanctions exactly one retarget (`readOnlyReason`), and
  `19-guest-standing-link.md:208` pins that server message as „the shipped message",
  so changing it here would move a contract module 19 is written against. Recorded,
  not changed. ~~It never reaches CS-T4's sweep because that sweep runs on the READ
  view and this message only appears after a refused PUT.~~ ⚠ **THAT SENTENCE IS WRONG
  IN BOTH HALVES — corrected at the closeout review (2026-09-20), and the correction
  matters because the PO is being asked to decide on it.** `resolveLink()` serves the
  string from **TWO** call sites, not one: `POST /api/guest/:token/orders` answers **409**
  (`guest.js:763`) and that message DOES reach a guest's screen — `GuestOrder.vue` assigns
  it to `checkoutError` and renders it in the `checkout-error` banner — while
  `GET /api/guest/:token` answers **410** (`guest.js:538`), whose message `GuestOrder.vue`
  discards in favour of its own copy. So it is reachable, it is a PUT-independent path, and
  the only reason the sweep misses it is that the sweep loads the READ view of a resolvable
  link, never a refused write.

  ⚠⚠ **And the list was presented as complete when it was not.** Two further guest-facing
  strings render app-owned copy with the banned word, and both were missing from it:
  `frontend/src/views/GuestOrder.vue:170` („Cyklus sa medzičasom uzamkol — objednávky už
  neprijímame.", pinned by `guest-invite-dead.spec.js:381`) and
  `frontend/src/components/GuestProductGrid.vue:76` („V tomto cykle zatiaľ nie sú žiadne
  produkty."). The second renders inside `GuestOrderStatus.vue`'s OWN edit mode, so
  §UC-CS-008's „the page contains neither „kolo" nor „cyklus"" is true **of the read view
  only**. Leaving all three is still right — `18-portal-information-architecture.md`'s
  hand-off list already owns the two client ones and 19 §208 pins the server one — but the
  PO decision has to be made on the real inventory, which is THREE strings plus a read-view
  caveat, not one.

The supersession was written into every copy: `06-guest-flow.md:48` (conflict #1) and
`:456` (the `readOnlyReason` table) both carry ~~strike~~ + pointer, the view carries
the reason at the computed, and the shell spec's assertion carries the citation.

### 7. FUP-T13's sweep: `stage` is the odd one out on BOTH cycle routes

The three new fields do not behave alike, and one sentence in §UC-CS-009 item 3
covers both describes as if they did:

| route | `opens_at` / `closes_at` | `stage` |
|---|---|---|
| `POST /api/cycles` | `bindValue` ⇒ absent ⇒ **201**, column NULL | **IGNORED outright** ⇒ 201, column NULL (17 §UC-CS-002: a new cycle is open/planned) |
| `PATCH /api/cycles/:id` | `bindValue` ⇒ skipped ⇒ **200**, stored value survives | **400 `Neplatná fáza`** — NOT read through `bindValue` |

So `stage` got its own test in each describe rather than a row in the field loop, and
the PATCH one carries the ordering proof: a VALID enum value on the same open cycle is
refused by a DIFFERENT door (409 `not_locked`), so the 400s came from the shape guard
and not from a route that 400s every `stage` key.

⚠ **The `opens_at`/`closes_at` rows were seeded with REAL dates** on the shared
`t13Cycle` fixture (`2026-12-01` / `2026-12-20`). Without that, „the stored value
survives an unbindable shape" is null-survives-null — the vacuous version of the claim
the whole FUP-T13 block exists for.

### 8. Mutations run (all reverted from a scratchpad copy, never `git checkout`)

| # | Mutation | Reds |
|---|---|---|
| M1 | drop `!isCancelled` from the card's `v-if` | the cancelled test, alone |
| M2 | render the card in edit mode too | the edit-mode test, alone |
| M3 | `<CycleTimeline :cycle="null" />` | 3 rendered tests + the `:cycle` source pin |
| M4 | restore „…v tomto cykle…" | `guest-status-shell:356`, the CS-T4 banner test, the source pin |
| M4b | „dve kolá" in the card label | the card-label pin + the sweep's `offenders` (as „KOLÁ") |
| M5 | PATCH dates lose `bindValue` | the FUP-T13 read-back loop, naming `opens_at` |
| M6 | delete the PATCH stage enum guard | the new PATCH `stage` test, alone |
| M7 | POST honours `stage` | the new POST `stage` test + CS-T1's „IGNORED" test |
| M8 | `closes_at: null` in the guest payload | the `when` test + the `arrived` test (+ CS-T1's listing pin) |

### 9. Small things

- The card renders in the OPEN state too (§UC-CS-008) — step 1 („Objednávky otvorené ·
  do …") is useful precisely while the guest can still edit. The status-404 card is a
  different branch with no cycle at all, so „no cycle, no timeline" needs no guard.
- The pills STAY and are asserted beside the card: `paid` (admin's) and `delivered`
  (host's) are this guest's BAG; the timeline is the ROUND. Both read-only.
- Edit mode hides the card for free — the whole read view is one `v-else` — so the
  test is about a structure, and M2 is what proves the test can see it break.
- The card is asserted NOT to be a direct child of `.app` (the `.app > *` cascade
  rule) and to sit inside `[data-testid="guest-status"]`.
- No `data-user-copy` marker was needed: every string the sweep reads on this page is
  either app copy or fixture data this row chose.

### What module 17 LEAVES BEHIND (the closeout's actual job)

A closeout is not „the last row passed". These are the things the four rows did not
finish, each with an owner, so the chain does not end at „the next row inherits it".

1. ⚠ **`FUP-T26` — the three stale-/reset-stage transitions (§10) close UNFIXED.** CS-T1
   measured them and offered „(1) fix, or (2) leave and pin"; CS-T2 took (2); nobody filed
   (1), so the module was about to close with a known defect and no owner. Now filed. The
   sharp end is **C** (`completed(ready) → locked` resets to `ordered`), which rewinds a
   handed-out round's timeline from step 5 to step 2 on the admin's own recovery path.
   Today it is invisible **because of one test** — the `status`-before-`stage` pin — and
   §UC-CS-005's seven-row acceptance table is a fixed point of that inversion, so the
   obvious test would not have caught it.
2. ⚠ **THREE guest-facing „cyklus" strings survive the module's own vocabulary ban**
   (`routes/guest.js:216`, `GuestOrder.vue:170`, `GuestProductGrid.vue:76`). Leaving them
   is correct — 19 §208 pins the server one and 18's hand-off list owns the two client ones
   — but §UC-CS-008's „the page contains neither „kolo" nor „cyklus"" is therefore true of
   the READ VIEW ONLY, because the third renders in `GuestOrderStatus.vue`'s own edit mode.
   PO decision pending; the inventory above is the real one.
3. **The vertical `when` line for step 0 („otvorí sa {opens_at}") is pinned at lib level
   only** — no module-17 surface renders a vertical timeline for a planned round (the admin
   header is compact; a guest sub-order cannot exist on a planned cycle). Module 18's
   landing is its first real render and owns that assertion.
4. **`§UC-CS-006`'s „5 `.ln`" was closing UNPINNED** and was caught here, not by a row:
   `grep '\.ln'` over the spec file returned nothing, and dropping the connector's `v-if`
   rendered six connectors with the entire suite green. Now asserted beside the dot count.
   ⚠ The lesson generalises past this module: **an acceptance criterion written as „exactly
   N of X and M of Y" tends to get pinned on X and silently dropped on Y.** Grep the
   criterion, not the feature.

---

## FUP-T26 — the lock default fires from `open` only (2026-09-20)

CS-T1 measured three transitions that leave `order_cycles.stage` disagreeing with `status`
(§10); CS-T2 pinned the frontend ordering that hides them; nobody owned the fix. This row
is the fix, and it is **one branch** — `backend/src/routes/cycles.js:555`, `cycle.status
!== 'locked'` → `cycle.status === 'open'`.

### 1. ⚠ The scope of the row IS the reading of the table — and the table answers it

The backlog row came with a reading attached and an instruction to verify it rather than
take it. Read directly, §UC-CS-002's PATCH table partitions the lock rule **by source
status**, in the rows' own parentheticals:

| Table row | Scope it states |
|---|---|
| „`status: 'locked'` **(transition INTO locked from `open`)**" | from `open` |
| „`status: 'locked'` **when already locked**" | from `locked` |
| „`status: 'open'` **while the cycle is `locked`**" (unlock) | from `locked` |
| „`status: 'completed'` ⇒ `stage` untouched" | the target, any source |
| „`status: 'planned'` — unchanged from today (no stage semantics)" | the target, any source |

So `completed → locked` and `planned → locked` are **unnamed**, and the shipped guard
(`!== 'locked'`) fired from both — wider than the only rule that authorises the write. The
reading holds, with one precision worth keeping: C is not a rule contradicted **verbatim**,
it is *a write the table never authorises*, made against the principle stated one row below
it („`completed` ⇒ untouched — it is the historical record of where the coffee ended", and
§UC-CS-003's „a hand-over on a completed cycle leaves `stage` as it was"). A and B are
conformant — the unlock rule is scoped to a `locked` cycle, and `planned` is explicitly
„unchanged" — so they stay, and the fix is one branch, not three.

### 2. ⚠ CS-T1's option (1) had TWO halves and only the second one is in scope

§10 offered „(1) clear `stage` on every transition OUT of `locked` **and** make the lock
branch `=== 'open'`". The first half is precisely what the table forbids: clearing on
`locked → planned` contradicts „`planned` — unchanged from today", and clearing on
`completed → open` widens a rule the table scopes to a locked cycle. Taking a recommendation
from a learnings file whole, without re-reading the spec it is a recommendation about, would
have shipped two deviations while fixing one.

### 3. ⚠ `planned → locked` narrows with C, deliberately — and it costs a documented claim

`=== 'open'` also stops `planned → locked` inventing `ordered`. That state is `locked` +
`stage IS NULL`, which §UC-CS-001's no-backfill rule makes first-class: `stageIndex()` maps
it to 2, the admin header's „Káva dorazila" button renders for NULL, and `markCycleReady()`'s
predicate is `stage IS NULL OR stage <> 'ready'`. Every screen is identical. It also removes
a SECOND rewind, one transition removed from C: `locked(ready) → planned → locked` used to
land on `ordered` too, and A being left standing is exactly what makes that chain reachable.

⚠ **The cost is that „a locked cycle with `stage IS NULL` is UNREACHABLE through the API" is
no longer true**, and that claim had ~~two~~ **THREE** copies: `cycle-stages.spec.js`'s
header (item 4), `e2e/README.md` (the spec entry and the DB_PATH list in the run recipe),
and **§CS-T3 item 4 of this very file** (`:379`). All rewritten with a strike + pointer.
⚠⚠ **The „two" was written from memory and was wrong about the file it was being written
into** — caught in review. That is the same defect this row fixes one layer up: a claim
taken from a summary instead of a grep. An enumeration of copies is itself a claim, and it
is the one most likely to be made without checking. The two DB_PATH-gated tests that manufacture the row are left
exactly as they are: a manufactured row is still the honest way to pin the PRE-MODULE state,
and retargeting them would trade a build-the-scenario gate for a coincidence.

### 4. ⚠ Every fixture here is built to NOT be a fixed point, and one shipped row was

The defect class is „the route wrote `ordered` where it should have written nothing", so a
fixture already at `ordered` proves nothing whatever the branch does. Each new test starts
from a stage that DIFFERS from `LOCKED_STAGE_DEFAULT` and asserts that as a precondition;
`completedWithStage()` refuses `'ordered'` outright. The `arrived` twin of C exists for the
same reason — a fix special-cased on `ready` would pass the first test alone.

⚠ The same trap had already bitten the shipped suite: CS-T2's „`status` before `stage`" test
carries `C = { status: 'locked', stage: 'ordered' }` labelled „completed(ready) → locked".
That row never discriminated anything — under `locked` a stage-first read and a status-first
read agree **by construction** — so it was documentation, and after this row its provenance
comment was simply false. A and B are what carry that test. Comment retargeted, assertions
untouched.

### 5. What is pinned, and where

`e2e/tests/cycle-stages.spec.js`, describe `FUP-T26 · 17 §UC-CS-002 — the lock default fires
from `open` ONLY` (8 tests, all API-level: drive the real PATCH, read the row back through
`GET /api/cycles/:id`). ⚠ **A rendered-step assertion could not be this evidence** — the
frontend masks all of it, which is the whole reason the defect survived a module closeout.

- C: `completed(ready) → locked` keeps `ready`; the `arrived` twin; the explicit
  `{status:'locked', stage:'ordered'}` reset still works.
- The counter-pin: `open → locked` still writes `ordered` **over a stale stage** (the fixture
  reaches `open` through transition B, so the row carries `ready` going in — a narrowing that
  removed the default instead of scoping it reds here).
- A and B, each pinned as DELIBERATE with the spec line that makes it conformant, so the next
  row can tell „looked at and left" from „nobody looked".
- `planned → locked` writes no stage; and the `locked(ready) → planned → locked` chain does
  not rewind.

### 6. Mutations run (both directions), all reverted from a scratchpad copy

1. **Guard restored to the shipped `!== 'locked'`** → exactly **4 red**: the two C tests and
   the two `planned → locked` ones. The other four stayed green — which is the proof that
   they pin behaviour this row did not change.
2. **Unlock branch widened to `status && status !== 'locked'`** (i.e. CS-T1 option (1)'s
   first half, the one rejected in item 2) → **7 of 8 red**, including the A and B
   deliberate-behaviour pins. Without this direction those two tests would be indistinguishable
   from assertions nobody can break.

Both reverted with `cp` from the scratchpad copy, never `git checkout` (which would have taken
the e2e file's uncommitted work with it).

### 7. ⚠ A pre-existing UI race in CS-T3's date savers, met twice and then not again

`CS-T3 … both dates save through the card and survive a reload` failed on the first two runs
(`closes_at` read back **null** after a 10 s poll) and passed on the next four, including twice
in the same file with the same diff, and once with the fix reverted. The mechanism fits the
code: CS-T3 deliberately moved `loadAll()` into `finally` (the snap-back requirement), so the
refetch triggered by saving `opens_at` can land BETWEEN the test's `fill()` of the second input
and its `click()`, resetting `closesAt` to `''` — and the save then legitimately sends `null`.
It bites only when that refetch is slow, which is why it showed up on a loaded box (23–59 s
runs) and vanished on quiet ones (12–15 s). ~~**Not caused by this row and not fixed here**~~
— **the implementer was right that the BACKEND diff cannot touch it, and the orchestrator took
the TEST-side fix in the same commit rather than banking a known flake.** It is not caused by
this row: it was introduced by **CS-T3**, which moved `loadAll()` into `finally` so a REFUSED
save snaps the control back. That was the correct change; the flake is its interaction with a
test that polls the API directly.

**The fix and its signal.** After the first save, the test now waits for
`cycle-opens-at-save` to return to ENABLED before filling the sibling field. That is the app's
own „refetch landed" edge, because `opensAtSaving` clears only after `await loadAll()` in the
`finally`. ⚠ Deliberately one-sided: a `toBeDisabled()`-then-`toBeEnabled()` pair would itself
flake on a fast box by missing the disabled window, and a fixed timeout would hide the race
rather than wait for it. If `loadAll()` ever rejected, the flag would stay `true` and the test
would time out loudly instead of passing. ⚠ Checked for siblings: every other `fill()`/`click()`
pair in the file is already safe — the refusal test gates its second fill on `toHaveValue('')`
(which IS the refetch landing), the clear test reloads instead of touching a sibling, and the
stage-button tests hold no input state for a refetch to clobber. No other spec drives
`expected_date`/`plan_note` through the UI, so the older savers have no exposed test today.
