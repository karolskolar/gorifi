# Admin sets a party's pickup point (helpers/pickup.js, PickupLocationPicker.vue)

> Moved verbatim out of `CLAUDE.md` on 2026-09-03 (it had grown to 153 KB). These are the full per-task learnings; the load-bearing rules are summarised in `CLAUDE.md` → Hard rules. **Append new learnings for this area HERE, and add only the one-line rule to `CLAUDE.md`.**

### Admin sets a party's pickup point, under all circumstances (PO, 2026-09-02 + 09-03)

`orders.pickup_location_id` / `pickup_location_note` were **write-once** — set by the
friend in `POST /orders/cycle/:cycleId/friend/:friendId/submit` and by nothing else — so
a wrong or since-changed pickup point could not be fixed and the Distribúcia sheet
disagreed with where the bags actually go.

⚠ **Shipped twice in two days, and the second day REPLACED the first.** 09-02 shipped
`PATCH /api/orders/:id/pickup` for submitted, non-Packeta orders. The PO then reported
the hole from a screenshot — *"ak priateľ neobjedná kávu a iba jeho neregistrovaný
kolega si objedná, nie je v sumáre objednávok zobrazenie pick up pointu"* — and asked
for it **"za každých okolností"**. That host has NO `orders` row, so an order-id route
could not address them at all. The live route is
**`PATCH /api/orders/cycle/:cycleId/friend/:friendId/pickup`** (`requireAdmin`); the
order-id one is **deleted, not deprecated** — two write paths to the same column is the
drift this file keeps warning about.

**⚠ `backend/src/helpers/pickup.js` IS THE ONE HOME for choosing the store.** A party's
pickup lives on their `orders` row when one exists (**any** status, draft included) and
on their **`guest_order_links`** row otherwise — one row per (host, cycle), which always
exists when guest bags do.
- ⚠ **THE CHOICE CANNOT BE MADE PER SURFACE, and this is the subtle part.** The orders
  tab lists a party who has an order **OR** guest bags; `/api/cycles/:id/distribution`
  builds its no-own-order rows `FROM orders … WHERE status = 'submitted'`. So a host
  sitting on a **draft** is "has an own order" to one screen and not to the other — a
  per-surface store would have written `orders` from the orders tab and read the link
  back on the picking sheet, for the same party. `pickupTargetFor()` answers "does an
  `orders` row exist", a fact about the database and not about the caller. Pinned by a
  test that writes once and reads **both** payloads for exactly that party.
- The synthetic distribution row's `pickup_location_*` were **hardcoded `null`**
  (`cycles.js`); they now come from `readPickup()`. The orders listing fills the same
  three fields onto every `id: null` placeholder from `linkPickupsByHost()`, so the
  frontend has ONE shape to render and one to patch regardless of store.
- ⚠ `pickupOf()` looks the location name up **without `active = 1`** — a place
  soft-deleted after an order chose it must still render its name, or the badge goes
  blank on a party whose pickup is perfectly well defined.

**⚠ The two new columns on `guest_order_links` are BOTH in the CREATE and in an
`ALTER TABLE` migration**, which is a deliberate exception to the GSO-T2 rule that the
three guest tables "never have to touch migrations". That rule stops a later task
re-declaring what the CREATE already has; these are genuinely new columns on a table
that already exists in prod and staging, where `CREATE TABLE IF NOT EXISTS` is a no-op —
without the migration the feature would work only on a database built from scratch.

**Money — what the route may and may not touch.**
- ⚠ **NO `transactions` ROW, EVER**, and no `total`/`status`/`paid`/`packed` write. That
  is the only reason it is safe to offer on a locked, part-paid cycle (the GSO-T6 lesson
  — a stray row corrupts a real friend's balance). Pinned by moving the pickup on a
  **paid** order and asserting the ledger row count is unmoved.
- ⚠ **The one money column it may move is `delivery_fee`, on a PACKETA order being
  switched to personal pickup** — a **conscious reversal** of 09-02's flat refusal.
  `packeta_address` and the pickup columns are mutually exclusive by construction, so
  leaving the fee would claim a delivery charge for a delivery nobody makes; both parcel
  fields are cleared with the switch.
- ⚠ **AND IT IS LEDGER-NEUTRAL — verified in the code, not assumed.** `PATCH
  /orders/:id/paid` posts `roundMoney(order.total)` and `helpers/packing.js` charges
  `-roundMoney(order.total)`: **both legs use `total` alone, and `delivery_fee` has
  never entered `transactions` at all.** So zeroing it moves no balance and invalidates
  no existing row. What it does change is what the friend was **asked** to pay
  (`paymentTotal = total + delivery_fee`, and the QR built from it) — which is why this
  ONE case sits behind an inline confirm that **names the amount**. Pinned by switching
  a *paid* parcel order and asserting the ledger is untouched while fee and address go.
- ⚠ **Switching TO Packeta is deliberately NOT offered.** It needs an address the admin
  does not have; `friends.packeta_address` holds only the friend's default.

**⚠ Other invariants, unchanged from 09-02.**
- **NO CYCLE-OPEN GATE** — the correction is needed exactly when the cycle is **locked**,
  because that is when the admin packs (same basis as `PATCH /:id/packed`). A test
  asserts the locked case *works*, so nobody "fixes" it into a 409.
- **EXPLICIT INTENT: exactly one of `pickup_location_id` / `pickup_location_note`.**
  `{}`, both, or neither is a 400 that writes nothing (the GSO-T4 `items: []` rule in its
  non-destructive form). Consequence, recorded: there is deliberately **no way to clear a
  pickup back to empty** — the admin's job here is to name the FINAL place. Every refusal
  test **reads the row back**; a status assertion cannot see a write that happened anyway.
- Refused: an unknown cycle, a party with **neither** store (404 — not listed on the
  orders tab either), an unknown or **deactivated** location, a note over **200 chars**
  (module 11 bound, mirrored as `maxlength`), and the FUP-T13 unbindable shapes — `{}` /
  `true` / `[id]` / `'abc'` are 400s, never a 500 with a stack. ⚠ The **one-element
  array** is the trap as always: `[3]` spreads to exactly the single bind slot the
  statement wants. ⚠ A test re-applies the whole bounds set **through the link store**,
  because that is a separate `UPDATE` and "the guards are shared" is otherwise a claim.

**⚠ `components/PickupLocationPicker.vue` — THE PILL *IS* THE `<select>`.** One home,
**two call sites in two different views**: `CycleDetail.vue`'s orders tab (the Status
column, where the badge already lived) and `Distribution.vue`'s friend card.
- The obvious build — badge, click to reveal a picker, pick, Uložiť — is three
  interactions and hides the control behind a state the admin has to discover. A native
  `<select>` styled as the shipped badge is **two** (open, pick), **saves on pick**, keeps
  the colour coding at rest (**blue** = configured location, **grey** = the friend's
  "Iné" note, **red** = still going by Packeta, **dashed** = nothing set) and costs no
  portal in a 33-row table. Native `<select>` with these exact Tailwind classes is the
  established admin-skin pattern (`AdminCatalog.vue`).
- ⚠ **Props are `cycleId` + `friendId`, never an order id**, and the component does not
  know which store the write lands on — if it ever starts guessing, the two surfaces
  drift apart again. Testids are keyed on the **friend** id for the same reason.
- ⚠ **It owns its own mutation, diverging from `GuestLinkRowControls.vue` on purpose.**
  That one keeps pending state in the parent because its two call sites render the SAME
  friend in the SAME view. Here they are separate views that never coexist, so
  parent-owned state would mean the identical optimistic-patch/rollback logic twice.
  Parents pass current values and patch their row from `updated`.
- ⚠ **`cleared_parcel` must be mirrored into the row** by both parents, or the row keeps
  rendering the parcel it no longer has: red "Packeta" over the new location, plus
  "(… + fee doručenie)" in Suma, plus the 📦 address line on the Distribution card.
- ⚠ **`v-model` on the select, NEVER `:value`.** Vue's `v-model` for `<select>`
  re-applies the selection *after* the `v-for` options are patched; a bound `:value` is
  set before its options exist and silently falls back to the first option.
- ⚠ **A refused change snaps the pill back.** The packing sheet is read as fact; "it
  looked like it saved" is how a bag goes to the wrong address.
- ⚠ **In Distribution the picker is `print:hidden` and BOTH badges are
  `hidden print:inline-flex`** — the pickup badge *and* the Packeta one. A printed
  picking sheet must state the place as TEXT, not render a dropdown box (the guest folds'
  rule); on screen the pill already says the same word in the same colour, so an
  always-visible badge would be the word twice. ⚠ In the print test the badge must be
  located by **testid** (`dist-pickup-badge-<friend.id>`), not by text: the select's own
  hidden `<option>` carries the same string, so `getByText` resolves to the very control
  the test is proving is gone.
- Both views load the location list **after** the cycle is known (filtered by cycle type,
  `for_coffee` / `for_bakery`, as the friend's order form filters it) and swallow the
  failure into **its own inline Alert** — an empty dropdown and a failed load look
  identical, and "no places are configured" would send the admin to Settings to
  re-create places that already exist.

**Not done, and worth knowing.** The friend portal still shows pickup from the friend's
own order only (`friends.js` `orderPickupName`), so a host with no own order does not see
where to collect their colleagues' bags — the link store has no friend-facing reader yet.
Guest sub-orders themselves carry no pickup at all: the host is the pickup party and
hands over (`delivered` is host-only), which is the model the whole guest feature is
built on.

Spec: `e2e/tests/order-pickup-edit.spec.js` (35 tests, API + UI on both surfaces);
`api-security.spec.js`'s `ADMIN_ENDPOINTS` carries the route. Verified against the prod
template: **35** in that file, **396** across `api-security` / `guest-distribution` /
`item-packed` / `guest-admin-view` / `money-rounding` / `nonstring-body-shape`, and
**171** across `guest-order-recovery` / `guest-host-view` / `guest-link` /
`share-dialog` / `guest-aggregation` / `guest-rewards`. ⚠ Two `catalog-admin.spec.js` UI
tests (CSV import report, duplicates merge) fail on any DB copy that has already run that
file once and pass in 3.3 s on a fresh copy — the documented accumulation trap, unrelated.


---

### FUP-T23 (2026-09-20) — `DELETE /api/pickup-locations/:id` knew only ONE of the two stores

**The bug.** The delete guarded itself with

```js
const referenced = db.prepare('SELECT COUNT(*) as count FROM orders WHERE pickup_location_id = ?').get(req.params.id);
```

— `orders` ONLY. Everything above this entry says a party's pickup lives on the `orders`
row *if one exists (any status)* and on `guest_order_links` otherwise. So the exact party
this whole feature was built for — **the host who orders nothing while their unregistered
colleague does** — kept their pickup where that count could not see it, and their pickup
point was **really deleted**. `loc<id>` with no row behind it: a silently dangling
identifier on a party whose pickup is perfectly well defined.

⚠ **Data loss, not a security issue** (the route is `requireAdmin`), and **reachable in
production**: DP-T2 reached the state through the public API alone, with no direct DB
write, while building a dangling-label fixture. The distribution payload already tolerated
it (key kept, `target_label: null`, the bag never dropped) — **that tolerance was the
symptom, not the fix**, and it is exactly why the bug could sit there looking harmless.

**The fix is an address, not a second query.** `helpers/pickup.js` gains
`pickupLocationInUse(rawId)` — the same two-store rule as `pickupTargetFor()`, asked the
other way round — and the route calls it. A hand-written
`OR EXISTS (SELECT … guest_order_links …)` at the call site would have been a **third**
statement of "where does a party's pickup live", and it would drift the next time the rule
moves (module 20 adds guest Packeta). The route now states the rule **zero** times, and
`pickup-location-delete.spec.js` reads its source to keep it that way.

Two deliberate properties of the helper:

- **Broader than `pickupTargetFor()` on purpose.** It counts a reference in EITHER table,
  not only in the one that is effective today: a friend with an `orders` row can also
  carry a stale `guest_order_links.pickup_location_id` that becomes effective the moment
  the order row goes away. Wrong in the conservative direction only keeps a row nobody can
  choose any more; wrong the other way destroys a live reference.
- **Fails closed** on an unbindable id (the `helpers/stock.js` NaN rule) — an id it cannot
  bind is an id whose references it cannot count. The route resolves the row first, so
  this is a backstop, not a path.

**The sweep.** `pickup_location_id` has exactly one other "is this referenced?" reader in
the tree, and it is not one: `cycles.js`'s `locationsById` is a *label* lookup, not a
reference count. So the sweep found ONE call site, and after the fix there are zero
hand-written ones. What the sweep DID turn up is an adjacent duplicate left alone
deliberately: `routes/orders.js`'s submit path inlines
`SELECT * FROM pickup_locations WHERE id = ? AND active = 1`, a byte copy of
`activeLocation()` — a different question ("is it choosable?"), pinned by FUP-T15's 400
tests, and not this row's.

**The e2e seam this row broke, and how it was re-armed.**
`distribution-handover.spec.js`'s synthetic-host fixture built its dangling location **by
leaning on this bug**. After the fix that DELETE soft-deletes, so the label resolves and
the fixture stops dangling. The describe split in two:

- the API-reachable half is now **"a RETIRED pickup point still names the group it
  holds"** — ungated, and it is itself a regression guard for the fix (it reddens under
  the mutation with `FUP-T23: the row survives — the link store is a reference`);
- the genuinely dangling half moved to its own describe behind a **`DB_PATH` skip**, which
  destroys the row directly. ⚠ That gate is of the *build-the-scenario* kind, not the
  extra-assertion kind, and **the reason it had to become a gate is the proof the fix is
  complete**: both writers of `pickup_location_id` (`POST …/submit` and
  `PATCH …/pickup`) refuse a non-active point, so with the delete guard fixed there is
  **no sequence of API calls** that leaves a party pointing at a row that does not exist.
  The tolerance stays pinned because databases written before this row still carry
  dangling ids. Recorded in `e2e/README.md`'s DB_PATH list — the skip count is the tell.

**Mutation proof** (the row was explicit that a test covering only the already-working
case proves nothing). Reverting `pickupLocationInUse()` to the shipped `orders`-only COUNT
and restarting the gate server: `pickup-location-delete.spec.js` → **2 failed / 5 passed /
0 skipped**, and the two failures are exactly the link-stored cases `(c)`, with `(a)`
submitted, `(b)` draft and both hard-delete baselines still green. The file is written as
a matched pair for precisely that reason — same party, same assertions, one variable.

**Telling the two deletes apart without the database file.** Both answer `204`. The only
API-level discriminator is `GET /api/pickup-locations/all` (admin, includes inactive):
soft ⇒ the row is there with `active: 0` and has left the public picker list, hard ⇒ the
row is gone from `/all` and a second DELETE 404s. Every assertion in the new file reads
the row back that way.

**The review catch worth more than the fix: a comment that ADVERTISED a net that did not
exist.** The new spec declined to write a 401 test "because the route is already in
`ADMIN_ENDPOINTS`". It was not. `/api/pickup-locations` is a **mixed mount** with no
`requireAdmin` on the mount (`index.js:77`), and **none** of its four admin routes — the
delete, the create, the update, the `/all` list — was in that sweep; the only entry for
that path was the PUBLIC `GET`, in `PUBLIC_ENDPOINTS`, which is what the original grep hit
and misread. No live exposure (each handler carries its own guard), but an edit dropping
one of those four `requireAdmin` arguments would have shipped green, and the comment would
have told the next reader not to look. **All four joined `ADMIN_ENDPOINTS`** (+4 tests).
⚠ The general rule this produces: *a comment that claims coverage elsewhere is an
assertion, and it must be verified like one.* Grepping a path in `api-security.spec.js`
does not tell you WHICH list it landed in.

**Superseded copies rewritten** (Documentation discipline — grep, do not trust a map).
Four in code (`pickup.js`, `delivery.js`, `cycles.js`, `PickupLocationPicker.vue`) plus two
the first sweep missed: `docs/learnings/01-early-features.md` carried the original rule as
"Delete with existing **orders** = soft-delete", struck with a pointer here; and
`distribution-handover.spec.js`'s fixture-hygiene comment restated it in its retired form
(behaviourally still true for those three locations, so reworded rather than changed).

**Filed as its own row: FUP-T25** — `routes/orders.js` submit inlines a byte copy of
`activeLocation()`. Leaving it out of this row was right (different question), but the
project's practice for an unowned seam is a backlog row, not a paragraph in a learnings
file. It is load-bearing for THIS row's claim: "no API path can dangle a location" rests on
*both* writers refusing an inactive point, and today a mutation in `activeLocation()`
reddens only one of them.

**Recorded, no action:**
- Every location this spec creates is retired or deleted before the file ends, so none
  lengthens the `PickupLocationPicker` options in other files — the global-fixture leak
  `distribution-handover.spec.js` warns about.
- `segment_key` freezes `loc<id>` at enqueue (DP-T3), and a re-point + delete can now leave
  a frozen key naming a row that is genuinely gone — correct behaviour, inert today because
  nothing reads the key back. A line went on **WA-T5**'s row: when that module groups by it,
  treat a frozen key the way the distribution payload treats a dangling id.
- `pickupLocationInUse()` scans both tables without an index — a non-issue at this size on
  an admin-only delete.

Gate, on a fresh per-run template copy, `DB_PATH` + `SERVER_LOG` set, `--workers=1`:
**239 passed / 0 failed / 0 SKIPPED, exit 0** —
`api-security` 80 (was 76; +4 from this row) · `distribution-handover` 43 ·
`order-pickup-edit` 35 · `guest-host-view` 29 · `distribution-board` 26 ·
`guest-distribution` 19 · `pickup-location-delete` 7.
⚠ **RECONCILED — both numbers were right, for different file lists.** The orchestrator's
246 was an EIGHTH file (`distribution-rows.spec.js`, 11) measured BEFORE this row added the
four `ADMIN_ENDPOINTS` entries: 239 − 80 = 159 over the six shared files, + 76 (`api-security`
pre-sweep) + 11 = 246. Re-measured on the final tree: the 7-file list is **239**, the same 8
files are **250** (239 + 11). ⚠ **The habit that resolved it is the point, and it is the rule
to keep: the implementer REFUSED to adopt a number it could not reproduce, and said so, rather
than reconciling on paper.** A count cited as evidence across rows is a measurement; if two
runs disagree, the file list is the first thing to compare, and the fix is to re-run — never
to average, adopt, or hand-wave.

---

## FUP-T25 — the SECOND pickup rule with two statements of itself (2026-09-20)

Filed by FUP-T23 and deliberately left out of it. FUP-T23 fixed "is this point
**referenced**?" (`DELETE /api/pickup-locations/:id` counted `orders` alone instead of
asking `pickupLocationInUse()`). This row fixes "is this point **choosable**?" —
`POST /orders/cycle/:cycleId/friend/:friendId/submit` ran
`db.prepare('SELECT * FROM pickup_locations WHERE id = ? AND active = 1').get(…)` inline,
a byte copy of `helpers/pickup.js activeLocation()`, while the sibling
`PATCH /orders/cycle/:cycleId/friend/:friendId/pickup` already called the helper for the
same gate with the same sentence.

**⚠ The two questions were NOT merged, and the temptation was real** — same table, same
column, adjacent lines in the same helper. They move in opposite directions on every axis:
`pickupLocationInUse()` is deliberately BROAD (both stores, effective or stale) and fails
**closed** (an unbindable id answers "in use", because a delete guard that is wrong
conservatively only keeps a row nobody can see); `activeLocation()` is deliberately NARROW
(`active = 1` only) and fails to **`null`**, so the caller's own 400 answers. One function
would have to be wrong for one of its two callers. The comment at each site now says so,
in both directions, so the next reader does not re-open it.

**The diff is three lines of code.** The gate became
`if (!activeLocation(pickup_location_id)) { … }`. `const pickupLocationId =
bindValue(pickup_location_id)` STAYS — the UPDATE below still binds it — and the presence
test stays on the RAW value (FUP-T15), which is safe because the helper runs the same
`bindValue()` internally.

**Were the two copies actually identical? Verified, not assumed** — the row said any
difference is the interesting part.
- **The gate: yes, byte-for-byte in behaviour.** Probed against better-sqlite3 directly for
  every shape the routes can be handed: `true` → `TypeError`, `{}` → `RangeError`, `[1]` →
  SPREADS and matches the row, `undefined` → binds as NULL, no throw, no row. Both copies
  route all of them through `bindValue()` first, so all four reach the same 400. The one
  shape worth naming is `undefined`: it does NOT throw in the binder, so the inline copy's
  `.get(pickupLocationId)` on an unbindable id was already a clean "no row", and the
  helper's explicit `if (id === undefined) return null` is the same answer stated earlier.
- **ONE REAL DIFFERENCE, OUTSIDE THE GATE, LEFT ALONE ON PURPOSE.** The PATCH writes
  `location.id` — the row's own INTEGER, "never the bound request value: it can then not
  land in the column as the text `'3'`". The submit writes `pickupLocationId`, the bound
  REQUEST value, so `{"pickup_location_id": "3"}` stores the *string* `'3'` in
  `orders.pickup_location_id` — or so it looks. **Measured, because "looks like" is not
  evidence:** submitted `{"pickup_location_id": "109"}` against the gate server and read the
  column back with `typeof()` — `{"pickup_location_id":109,"t":"integer"}`. The column is
  `INTEGER`-affinity, so a numeric string is CONVERTED on the way in, and a NON-numeric
  string can never reach the write at all (it matches no row, so the gate 400s it first).
  The difference is therefore provably inert, not merely unobserved. The row asked for a
  behaviour-identical refactor, so the write site was not touched. ⚠ **Recorded rather than
  fixed**, because it is the kind of thing a later row wants to know: the two writers of
  this column agree on what they REFUSE and differ in what they BIND, and the affinity is
  the only reason that costs nothing. A column that ever loses `INTEGER` affinity, or a
  second store whose column does not have it, turns this back into a real divergence.
- **The refusal envelopes differ, and that is correct.** The submit answers `{ error }`
  with no `field` marker; the PATCH answers `{ error, field: 'pickup_location_id' }`,
  because its body has two candidate fields and the UI marks the offending control. Both
  shapes are now pinned (exact key sets), so the shared gate cannot align them by accident.
  The sentence itself is identical and unchanged.

**The acceptance was the mutation, and it was run in BOTH directions, BEFORE and AFTER.**

| mutation in `activeLocation()` | before the refactor | after |
|---|---|---|
| drop `AND active = 1` | PATCH's "refuses a DEACTIVATED point" alone — **the submit stayed green off its own copy** | BOTH writers' refusal tests |
| `return null` for everything | (not run — same shape) | BOTH writers' "NOTHING TIGHTENED" tests |

The first row is the hole. ⚠ **The count first written here — "3 failed / 14 passed" — was
STALE (it sums to 17, and the shipped file has 18); it came from the 17-test draft.** Review
reproduced the state independently, in an isolated copy of `backend/src` on its own port,
without touching the repo: **3 failed / 15 passed, and EVERY failure on the PATCH side — the
submit's „refuses a DEACTIVATED point" stayed GREEN off its own copy.** ⚠ Against a genuine
pre-refactor tree it is **4 failed / 14 passed**, because the one-home grep test reds on two
hits as well. That is exactly the state in which FUP-T23's "no API path can dangle a location"
claim would have gone quietly false. ⚠⚠ **And the stale number is the lesson from two
paragraphs above, committed again in the same file: a cited count is a MEASUREMENT.** It was
caught only because review re-ran it instead of reading it. If a number appears in a
write-up, it must come from the run the write-up describes — not from an earlier draft of it.

**⚠ THE TEST-DESIGN LESSON, and it cost a run to learn: a fixture must not depend on the
gate under test.** The first draft of `pickup-active-gate.spec.js` built its retired point
the pretty way — submit an order with it, then let FUP-T23's soft-delete retire it, which
also tied the two rows together in one fixture. Under the null-mutation that `beforeAll`
died on its own first assertion, and Playwright reported **1 failed, 16 did not run**: the
two writers' halves never executed, so the mutation proof could not tell them apart at all.
Rewritten to retire the point through the plain admin `PATCH /api/pickup-locations/:id`,
i.e. through NEITHER writer, the same mutation reports 3 failed / 15 passed and NAMES both
writers. The lifecycle the first draft was reaching for is still pinned — as a *test*
(usable today → referenced, so DELETE deactivates → refused by both writers tomorrow),
where its failure costs one test instead of the file. **Generalised: a `beforeAll` that
exercises the behaviour under test converts every interesting failure into the same
uninformative one.**

**⚠ A comment can break a grep-stated rule.** The acceptance is "a grep for
`pickup_locations WHERE id = ? AND active = 1` returns the ONE home". The first version of
the new comment quoted the old statement verbatim to explain what it replaced — and the
grep returned two hits again, one of them prose. The comment now describes the statement
instead of reproducing it, and says why. The same trap waits for any rule the project
states as a grep.

**Files:** `backend/src/routes/orders.js` (the gate + its comment),
`e2e/tests/pickup-active-gate.spec.js` (new, 18 tests), `e2e/README.md` (layout entry),
`CLAUDE.md` (one line). `helpers/pickup.js` UNCHANGED — the helper already said it right.

**Gate**, fresh per-run template copy, `DB_PATH` + `SERVER_LOG` set, `--workers=1`, each
file run on its own, **every one exit 0 with ZERO skips**: `pickup-active-gate` 18 ·
`order-pickup-edit` 35 · `pickup-location-delete` 7 · `distribution-handover` 43 ·
`nonstring-body-shape` 272 · `malformed-body` 19 · `api-security` 80 = **474 passed / 0
failed / 0 skipped**. `order-pickup-edit` and the two body-shape files ran UNMODIFIED, as
the row required — they are what pins the refusal's status and sentence, and neither moved.
