# 08 — Distribution pipeline (module 16)

Per-task lessons for `docs/specification/16-distribution-pipeline.md` (DP-T1 … DP-T8,
2026-09-20). Read this before touching `backend/src/helpers/delivery.js`,
`helpers/handover.js`, `helpers/outbox.js`, `GET /cycles/:id/distribution`, the
`handed-over` routes, `frontend/src/views/Distribution.vue`, or the admin cycle header
shared by `CycleDetail.vue` and the board.

Six rows deferred their write-up to the closeout, so this file is organised by **lesson**,
not by task. The per-row blow-by-blow (including what review caught in each) stays in
`docs/specification/PROGRESS.md`'s log; here is what a later reader has to know.

---

## What the module actually is

A bag moves through **three stages**, and each stage has exactly one home:

| Stage | Who moves it | Where the rule lives | Ledger? |
|---|---|---|---|
| 1 `to_pack` → items ticked | admin | `helpers/packing.js` (unchanged by this module) | — |
| 2 `packed` | admin | `helpers/packing.js` — **the ledger moment** | yes |
| 3 `handed` | admin | `helpers/handover.js` + the two `handed-over` routes | **never** |
| — cycle `completed` | admin, by hand | the „Ukončiť objednávku" button, nothing else | never |

`stage` is **derived**, never stored: there is no `orders.stage` column, only
`handed_over_at` plus the existing `packed`. `helpers/delivery.js` decides which TARGET a
party is on (Packeta / a pickup point / in person) and is **read-only by contract** — it
never imports `helpers/pickup.js`, which stays the sole WRITER of the pickup columns. Those
two halves are the whole classification: everything the board and the plan line render is
`plan[]` / `totals` / `party.delivery` / `party.stage` off `GET /cycles/:id/distribution`,
and **nothing is re-derived client-side**. A second client-side classifier is the drift this
module was built to avoid.

---

## The lessons

### 1. A "patch in place, then re-fetch" pair is UNTESTABLE unless the test holds the second call

The board patches a row optimistically and then re-fetches under `loadSeq`. Deleting the
patch left the whole file **green**, because the re-fetch produced the same screen a few
hundred milliseconds later. The fix is to `page.route`-**hold the GET** so the row must read
`handed` while `plan[]` still shows the old numbers — and the hold must be generous (4.5 s
here; 2.5 s was inside the noise of this 2-core box, so the mutant could read green again and
quietly undo the thing the test had just caught). Anything measured against that window — a
toast lifetime, for instance — belongs INSIDE the held window, or it measures "some time
before the re-fetch landed".

**Carry this beyond module 16: every optimistic-update-then-reload pair in this app has the
same hole.**

### 2. Four classes of vacuous assertion showed up in eight rows. Assume you have one.

- A **cap** test that used ids from another cycle: with the cap deleted the route still
  refused for a different reason, so the test proved nothing about the cap.
- A **non-vacuity gate that was itself vacuous**: "other active points are listed" leaned on
  the prod template happening to carry six, while the README sanctions running without it.
- The **patch-then-re-fetch** pair above.
- A **shipped 1-in-10 flake** (`guest-admin-view.spec.js`): a row-scoped
  `not.toContainText('30.00 EUR')` straddled two cells — order id `243` + `0.00 EUR` — so it
  reddened only when `orders.id % 10 === 3`. An earlier "green 1865-test full suite" had
  passed **by luck**.

The counter-measure that worked every time: **mutate the code and watch the test fail**, and
put a presence assertion on the same locator family in front of every absence assertion.

⚠ And the flake's diagnosis was **right fix, wrong reason** — Playwright resolves text from
`textContent`, not `innerText` (`useInnerText` is the opt-out), and Chromium's real
`innerText` inserts a TAB between cells and does NOT reproduce it. A reader checking the
claim in devtools would have concluded the rule was bogus and undone a correct fix. **The
wrong reason is what gets written down and believed.**

### 3. A sanction is permission, not an obligation

DP-T6 was explicitly allowed to retarget `guest-distribution.spec.js` where it assumed the
per-friend Card layout. It declined — because `item-packed.spec.js` uses **the same two
locator idioms** (`div.p-4` carrying the heading; `div.cursor-pointer` as the item rows) and
was pinned as passing unmodified, so consuming the sanction would have bought nothing: the
invariant still had to hold for the un-sanctioned file. It preserved the markup instead (one
padded wrapper per party; the expand affordance a `<button>` with a scoped class rather than a
third `div.cursor-pointer`). **Both specs are byte-untouched through the entire module.**

Consequence for later rows: `div.p-4` and `div.cursor-pointer` inside a party are
**load-bearing selectors**. `distribution-board.spec.js` asserts `toHaveCount(1)` on exactly
that locator so a new wrapper carrying the same utility class reddens immediately.

### 4. A premise written into a backlog row is a CLAIM, not a fact

The orchestrator's seam note on two rows argued "one door, not three, because the other cancel
paths are gated to an OPEN cycle and a hand-over cannot have happened yet". **False**: no
hand-over route carries any cycle-status gate at all, so a bag can be handed over while the
cycle is still open — exactly when those doors are allowed. A fix at the admin cancel alone
would have been the half-way fix the note itself ruled out. Nobody had checked it against the
handler.

**Still open** (recorded at three sites, owned by whichever row touches it first): a guest
sub-order **cancelled after a hand-over** is unreachable in both directions — the host's
reversal skips cancelled bags, the per-bag route refuses them (`cancelled` is terminal), and
`softCancelGuestOrder()` clears neither `handed_over_at` nor the `queued` notification. The
bag stays stamped and a „odovzdané" message stays queued for something nobody will receive.
Complete fixes: `softCancelGuestOrder()` (module 14 policy, the one home all three doors
share) or WA-T5's release-time `skipped` guard. A fix anywhere else is partial.

### 5. Two writers of the same column will disagree unless you make them agree on purpose

The bulk route skipped an already-handed order — **and skipped its guests' inheritance with
it**, so a guest bag added after the host's went out was never stamped by a re-run, while the
per-bag route deliberately does the opposite. The board's group button is the unit of work, so
the bag it left behind was invisible from the only screen that could have fixed it. The skip
now skips the **id**, never the bag's write (§UC-DP-006's own wording). A late colleague takes
**the bag's** stamp (`row.handed_over_at || stamp`), not the batch's, so a host and their
colleagues always carry one string.

That test is also the **only non-flaky proof the batch timestamp is BOUND rather than
re-evaluated** — same-batch writes land in the same second anyway, so "one timestamp across
the batch" cannot tell an inline `CURRENT_TIMESTAMP` from a bound one; a bag stamped in an
earlier batch can.

### 6. Correct today, wrong the moment something downstream changes

Three defects of exactly this shape, all caught in review, none visible in its own row:

- The outbox **enqueued on every `true`**, including a call that changed nothing. Harmless
  while every row is `queued` (the idempotency key dedupes) — and a **duplicate WhatsApp
  message to a real person** the moment module 21 moves a row to `released`. Both routes now
  key the enqueue on the UPDATE's own `changes`. Pinned by a test that flips this cycle's rows
  to `sent` (removing the dedupe that would hide the bug) and repeats.
- A **reversal of nothing reversed everything**: `handed_over: false` on an order that was
  never handed over cleared every live guest's stamp. Spec-conformant (the use case's SQL is
  unconditional) and destructive; now guarded on the order's own prior stamp.
- A **focus that outlived its target**: the board's focused plan card is a local `ref` while
  `plan[]` is the server's, so retiring a point left a toolbar over zero groups with no card
  left to click to release it — unreachable in DP-T5, reachable the moment DP-T6 added the
  pickup re-fetch. Guarded inside the `loadSeq`-checked write block.

**When a row ships a seam, ask what the NEXT row makes reachable.**

### 7. `disabled` is not a guard, and a refusal must share a scope with what it advises

A `disabled` attribute does **not** stop a dispatched click reaching the handler (measured
empirically in a throwaway browser: a real `click()` fires nothing, `dispatchEvent` fires
twice). Every gated action in this module therefore carries a JS in-flight / precondition
guard as well — including DP-T8's „Ukončiť objednávku", whose gate is UX-only and whose server
accepts the write regardless.

And two refusal-lifetime bugs, one per row, both on a money-adjacent screen:

- A per-row error („Najprv označte balíček ako zabalený") was cleared only by another attempt
  at the **same** step, so it survived the admin doing exactly what it asked. It is now
  cleared in **both doors that act on the advice** — and deliberately NOT in the loader's
  success path, because the loader also runs after a snap-back and would wipe the sentence in
  the tick it was written.
- A group-level refusal wiped the highlight map **globally** while clearing only its own
  group's message, leaving another group's Alert with nothing highlighted and its clearing
  path early-returning — with that group's ready count at 0 there was **no path short of a
  reload**. Keyed per group now, with the invariant stated: **a group Alert always has at
  least one highlighted row, because those rows are what clear it**; a refusal naming nothing
  this board can resolve goes to the page banner, which every row action clears.

### 8. Snap-back has to be hand-written

Vue skips patching a `:checked` binding whose value did not change, so after a refused toggle
the user's gesture would simply stand. The property is set directly, read **before** the
re-fetch replaces the party objects, and the inline message is the **server's** sentence
verbatim rather than an invented one.

### 9. Sometimes the SPEC is what disagrees, and the answer is a PO line, not a code change

Three in this module (all carried to the closeout as questions, §"Open items raised at the
module-16 closeout" in the spec file):

- A packed FRIEND row has no body at all (the shipped `v-if="!friend.packed"`, pinned by
  `item-packed.spec.js`), so it **prints no item list**, while §UC-DP-011's print paragraph
  says every row prints expanded. "Collapsed after packed, click to expand" is therefore a
  real fold only for **synthetic hosts**.
- The „{checked}/{total} ✓" packing counter stays on the summary line, not where §UC-DP-011
  places it.
- The in-person target reads „Osobne" on its plan card and „Osobné odovzdanie" on its group
  header — **both literally as specified**, in two neighbouring pieces of the same screen.

The fourth was the opposite — a spec sentence that is ungrammatical at some counts
(§UC-DP-012's subtitle pairs a plural noun with a singular verb: „2 balíčky prejde"). There
the CODE was made to agree (`bagsMoveVerb()` in `lib/plural.js`, the declared one home for
count-agreeing Slovak forms), because shipping a known grammar error to make a prose sentence
match is the wrong trade.

### 10. A rule with no address grows copies

`lib/plural.js` absorbed `bagsLabel` / `packedAdjective` / `handedAdjective` / `guestsLabel` /
`bagsMoveVerb` — **extended, never forked** — and the participles are bare adjectives
precisely so a later row can compose them with a count. DP-T8 did the same for the header:
`lib/distribution-plan.js` owns the plan sentence and the completion gate because
`CycleDetail.vue` and `Distribution.vue` render the same header (and module 17's stage
controls join it next).

~~The counter-example is still open: **FUP-T24** — the kg display rule `Math.round(g/10)/100`
has FOUR copies and CLAUDE.md states it **without naming a home**.~~ — **CLOSED by FUP-T24,
2026-09-20.** The rule now lives in `frontend/src/lib/kg.js kgLabel`, which all four surfaces
import; see `docs/learnings/03-friend-portal-restyle.md` §FUP-T24. DP-T5 added the fourth copy
deliberately, with a pointer, rather than refactor three shipped files under a board row: the
right call there, the wrong steady state — and the steady state is what this row corrected.

### 11. Harness traps this module paid for

- **One admin token app-wide.** A UI login mints a new one and invalidates the API context's.
  A test that drives the page AND the API must **adopt the browser's token**
  (`localStorage.adminToken`), not mint a fresh one — otherwise the page's next request 401s.
  The reverse (`refreshAdminToken()`) is for fixture teardown after a UI test.
- **`-g` against a serial describe is meaningless** when the test depends on earlier tests'
  state: only the fixture `beforeAll` runs, so the non-vacuity assertion fails first. Mutation
  checks on such a file must run the whole file (or target a test that needs only the fixture).
- **`pickup_locations` is GLOBAL**: every active row becomes a zero-count plan card and an
  empty group in **every** cycle, including other specs'. Specs that create locations retire
  them in `afterAll`, and none asserts a total group count under „Všetko".
- **`PATCH /orders/:id/packed` is a TOGGLE** — a fixture helper that "packs" twice silently
  un-packs and posts a ledger reversal. Read the state first.
- **`DB_PATH` silently removes assertions**; `SERVER_LOG` silently self-skips ~21 tests. **The
  tell is the SKIP count, not the failure count.** `RUN_DB=$(mktemp) && … &` backgrounds the
  whole `&&` list, so the variable never reaches the foreground shell — that produced a green
  false clean once already.
- ⚠ **The README contradicted itself about the rate-limit budgets, and it cost this row a
  9-minute false red.** Its runnable step 4 carried `RATE_LIMIT_AUTH_MAX=1000` while a later
  section of the SAME file says, in bold, that 1000 is measurably not enough for one full run.
  Following the runnable block gave **30 failed / 631 did not run**, every failure a `429` on
  an `admin login` in a `beforeAll` — indistinguishable from a mass regression in the diff
  under test. Fixed by raising step 4 to `100000` for all five and striking the superseded
  sentence. **A runnable block that contradicts its own warning is the worst possible copy of
  a rule**, because it is the one a reader actually executes.

---

## DP-T8 — the closeout row itself (2026-09-20)

**What shipped.** The admin cycle header, shared by `CycleDetail.vue` and the board:

- a **non-blocking** plan line (`data-testid="cycle-plan-line"`) on a `locked` or `completed`
  cycle — `loadDistributionPlan()` follows the `loadGuestUnpaid()` contract exactly (own
  sequence guard, failure swallowed into "no line", never into the page Alert, never blocking
  the tab);
- „Označiť ako dokončený" **relabelled „Ukončiť objednávku"**, gated on
  `totals.count > 0 && totals.handed_count === totals.count`, `title="Až keď je všetko
  odovzdané"` otherwise, on BOTH headers;
- the board appbar sub „· uzamknuté" / „· ukončené" (`board-appbar-sub`) and the
  „Vytlačiť štítky" placeholder, **disabled** and carrying `data-labels-route` — the same
  decision „Štítky" made in DP-T5, because `router.js` has no catch-all and pushing an
  unsupplied route renders a blank SPA;
- `lib/distribution-plan.js` as the one home of both rules.

**The one thing to remember about it: the gate is the INTERFACE's, not the server's** (PO,
2026-09-19). `PATCH /cycles/:id { status: 'completed' }` still accepts a cycle with un-handed
bags — an escape hatch for a bag that will never be collected. `distribution-board.spec.js`
asserts **both halves**, because a comment cannot stop the 409 that looks so obviously right
from being added later. And the button is the **only way a cycle becomes `completed`** — stated
as the VALUE, not as the column, because `CycleDetail.vue` writes `order_cycles.status` three
other times (open for ordering / lock / unlock) and "the only writer of `status`" would claim
more than it holds. What is true of the module: no hand-over path writes `status` at all, and
`markCycleReady()` promotes a stage INSIDE `locked`.

**Two findings recorded by earlier rows, fixed here** (both in shared code, which is why the
board rows declined to touch them):

- `DialogContent.vue` carried **no print rule at all**, so a packing sheet printed with any
  admin modal open came out under the `bg-black/80` dim layer with the modal box stamped
  across page one. `print:hidden` on the overlay **and** the box — one token each in the
  primitive every admin view consumes, so no view can forget it; a dialog that really is meant
  to be printed overrides it through `props.class` (`cn()` is tailwind-merge). Pinned with a
  screen-visible → print-hidden pair.
- `packedShare()` could emit a **negative width** if the server's `packed_count ⊇
  handed_count` invariant ever broke; CSS drops it silently and the bar would merely look
  "less packed". Clamped at 0, and pinned by a `page.route`-forged payload — the state is
  unreachable through the API, which is exactly why the guard needs a forged test.

**The review's own irony, worth more than the fix:** this row is the closeout, and it left the
board's `<DialogContent>` comment saying the primitive has no print rule and that the matter is
*„recorded for the module closeout rather than patched here"* — while patching exactly that. It
also kept a `print:hidden` at the call site, which would have quietly held that one dialog green
while the primitive's rule rotted, and made the box half of the new test prove nothing about the
primitive. Struck with a pointer, call-site token deleted, and the test now constrains the
primitive in both halves. **A rule moved into a shared home must be deleted from the call site in
the same commit, or the call site becomes the thing that hides its removal.**

**Three things known and not fixed** (record only):

- A party whose pickup row was **hard-deleted** (FUP-T23) renders a bare count with no name in
  the plan line — consistent with the plan card, which shows the same dangling target.
- A **transient failure** of the distribution request leaves the completion button disabled under
  „Až keď je všetko odovzdané", which then misstates why. Fail-closed and self-healing on the next
  load, but worth knowing: while the API has no gate, that button is the admin's only obstacle.
- The print test locates the radix **overlay by its utility classes** (`div.fixed.inset-0.bg-black\/80`)
  because the shared primitive has no test id — a brittle pin on a component every admin view
  consumes. Adding a `data-testid` to `DialogOverlay` would make it durable.

**Not fixed, and why:** the board page carries **two top-level `h1`s** (the appbar title and
„Distribúcia plán"). No locator is made ambiguous — every heading assertion in the suite
matches by name — and demoting the shipped appbar title is a markup change to a shipped
element that no use case asks for. Recorded as an accessibility nit for whoever next restyles
the admin skin; it is not a defect this row should fix silently under a closeout.

**Full suite at the milestone:** see the DP-T8 log entry in `PROGRESS.md` for the exact
totals and the skip list of the run this row gated on.
