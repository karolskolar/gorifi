# 10 — Portal information architecture (module 18)

Per-task lessons for `docs/specification/18-portal-information-architecture.md`. Read this
before touching the four friend routes, `frontend/src/lib/portal-state.js`,
`frontend/src/lib/dates.js`, the `portal-landing` marker, `e2e/helpers/portal.js`, or the
friend half of `GET /api/friends/cycles`.

---

## PI-T1 — the shell, the resolver, the dates lib, the gate retarget (2026-09-20)

**What shipped.** Three new routes (`/moje-objednavky`, `/zostatok`, `/ako-to-funguje`) on
`FriendPortal.vue` with `meta.view`, plus `meta: { view: 'shop' }` on `/`;
`lib/portal-state.js` (`resolveLanding`); `lib/dates.js` (`fmtDayMonth`, `fmtDate`,
`fmtWeekdayDayMonth`, `weeksUntil`); one extraction in `lib/cycle-stages.js`
(`newestCycleWith`); `data-testid="portal-landing"` + `data-view` + `data-landing-state` on
`FriendPortalSession.vue`'s page column; `orderPaid` / `orderHandedOver` /
`parcel_enabled` / `parcel_fee` on the friend cycles payload; `e2e/helpers/portal.js`; the
gate retarget across **28** spec files. **No view BODY** — those are PI-T3..T8.

### 1. ⚠⚠ THE DATE FORMAT IS A LIVE SPEC CONFLICT AND IT IS NOT RESOLVED — **PO QUESTION**

One sentence, two specs, two formats:

| Source | The „Ďalšia objednávka…" sentence |
|---|---|
| 17 §UC-CS-005, **shipped** in `cycle-stages.js nextOpeningText()` | „Ďalšia objednávka sa otvorí približne **3. októbra** (o 2 týždne)." |
| 18 §UC-PI-002, `nextText` via `fmtDayMonth` | „…približne **3. 10.**" |

Both cannot be right, and 18 §UC-PI-006 makes it worse by printing the SAME date in the
SAME modal twice — `fmtDayMonth(opens_at)` in 38 px display type, then `nextText` in the
banner underneath. **PI-T1 took the shipped form**, because the only alternative that
follows 18's letter is a second composition of a sentence module 17 owns, and this repo has
spent the week collapsing exactly that. `lib/dates.js` is still built exactly as §UC-PI-002
specifies — the drawer's „Otvorené do {fmtDate}", the status line's
„Objednávky do {fmtWeekdayDayMonth}" and the closed modal's big `{fmtDayMonth}` all need
it, and none of those is one of 17's sentences.

**The rule that came out of it, and it is the useful part: the split is by SENTENCE, not by
taste.** A date standing alone (display type, after a preposition, in a menu sub-line) is
SHORT and comes from `lib/dates.js`; a date inside one of module 17's composed sentences is
LONG and comes from `cycle-stages.js`. Written at the top of both files.

⚠ **PO decision needed**, and it is cheap to take either way — it is one function
(`nextOpeningText`), rendered on no screen at any point before PI-T4:
- (a) keep „3. októbra" everywhere, and amend §UC-PI-002/006's `fmtDayMonth` mentions to
  `fmtDay`; or
- (b) switch `nextOpeningText` to the short form, which changes module 17's shipped string
  and its `cycle-stages.spec.js` pin.

Until it is taken, the closed modal will show „**3. 10.**" in the card and „približne
**3. októbra**" in the banner below it. **PI-T4 must not paper over that by formatting one
of them at its call site** — that is how the second home gets created after all.

### 2. The duplication with module 17, and how much of §UC-PI-002 was already shipped

§UC-PI-002 reads as if `nextText` and the open→locked precedence were new. They shipped
**the day before**, in CS-T2. What PI-T1 actually added is thinner than the spec suggests:

| §UC-PI-002 asks for | Where it lives |
|---|---|
| `nextText`, three branches | **17's `nextOpeningText()`** — `resolveLanding` returns `.text` |
| open → locked precedence | **17's `currentCycleFor()`** — `resolveLanding` reads the STATUS of what it picked |
| the two-open `console.warn` | **17's**, tag `[cycle-stages]` and all |
| „newest" (`created_at` DESC, `, id DESC`) | **17's** private `newestFirst` |
| `state` / `catalogCycle` / `nextCycle` | genuinely new |

⚠ `currentCycleFor()` does not fit `resolveLanding` on its own — it answers „the newest
open, else locked, else planned", and the landing needs the newest `planned` *regardless*
of what is open (`nextCycle`) and the newest of the UNION `{locked, completed}`
(`catalogCycle`). The fix was to EXTEND 17's file, not fork the rule: `newestCycleWith
(cycles, statuses)` is exported from `cycle-stages.js` and `currentCycleFor` is rewritten on
top of it. Calling it once per status group IS the precedence; calling it with several
statuses at once asks the union question, which is exactly what `catalogCycle` is.

⚠ **`resolveLanding`'s `currentCycle` is `null` under `closed`** — NOT „the newest planned
one", which is what a naive `currentCycleFor()` passthrough would have given. A planned
round has no products a friend may look at; the closed grid reads `catalogCycle`. Conflating
them renders a planned round's empty catalogue as an empty shop.

⚠ The delegation is pinned by an assertion that could not be a tautology: `nextText` is
asserted BYTE-EQUAL to `cs.nextOpeningText(r.nextCycle, today).text` over six inputs. A
re-implementation following 18's letter produces a *different* string (§1), so equality is
evidence. Mutation-proved — a `fmtDayMonth` copy reds it, plus the junk-input test (a
re-written fallback sentence) and the source pin.

### 3. The retarget: the real numbers, and the one call site that was not a call site

The spec said 29 files, the backlog row said ~27. **Measured: 30 files, 72 occurrences**
(`grep -c "Objednávkové cykly" e2e/tests/*.spec.js`). Minus `portal-cycles.spec.js` (7) and
`portal-share-row.spec.js` (5), which PI-T3 deletes outright: **28 files, 60 occurrences
retargeted**, in three shapes —

- 57 × `await expect(page.getByRole('heading', …)).toBeVisible()` → `await expectLanding(page)`
- 2 × the same with `.toHaveCount(0)` (`magic-link:1549`, `portal-appbar:268`) → `expectNoLanding(page)`
- 1 × **`const PORTAL_HEADING = 'Objednávkové cykly'` in `google-auth.spec.js:1594`**, with
  **18 indirect usages** — invisible to a grep for the assertion shape, and the reason the
  spec's per-file table says „google-auth (1)". Constant deleted, all 18 retargeted.

⚠ `payment-links.spec.js` is in the real list and in NEITHER the spec's enumeration nor the
backlog row's: it landed with PL-T4, after the spec was written. **That is the whole reason
§UC-PI-019 item 2 says „re-enumerate before editing"** — and it is why the enumeration in
the spec has been struck in place rather than left to be trusted by PI-T3 and PI-T11.

### 4. ⚠ WHY `e2e/helpers/portal.js` SHIPS WITH TWO FUNCTIONS AND NOT SEVEN

§UC-PI-019 item 1 lists `expectLanding`, `openMenu`, `menuGo`, `logout`, `openProfile`,
`openInvite`. Five of the six drive the hamburger DRAWER, which **PI-T2** builds. Written
here they would be helpers no test can call and nobody can prove — dead code in the one file
28 spec files now depend on. PI-T2 adds them to THIS file (never a second helper module) and
retargets the logout/profile call sites onto them (items 4, 5).

### 5. ⚠ THE MARKER HAD TO BE ABLE TO FAIL, AND PROVING IT WAS THE POINT OF THE ROW

60 assertions moved in one commit. If `portal-landing` were also present on the LOGIN
screen, all 60 would go on passing while gating nothing — the exact silent-degradation shape
this codebase has produced seven times in two weeks. So:

- the first test drives **absent → present → absent** on ONE page object;
- **M1** put `data-testid="portal-landing"` on `FriendPortal.vue`'s `.app` root (i.e. on
  every auth state) → **10 tests red**, including the source pin that forbids the string in
  that file;
- **M9** deleted the marker entirely → **3 of 12 red in `modern-login.spec.js` alone**,
  which is the direct evidence that the retargeted files still gate.

⚠ **Placement: the PAGE COLUMN, not a root.** `FriendPortalSession.vue` is a FRAGMENT
component (the voucher banner is the column's sibling, both direct children of `.app` by
design, `.app > *` z-index cascade), so there is no single root to mark. The column is the
one node that renders in all four views, all three landing states and behind every modal
gate. It is asserted to resolve to exactly ONE element and to be a direct child of `.app`.

### 6. ⚠ MY FIRST DST ASSERTION WAS A FIXED POINT — THE SEVENTH IN TWO DAYS

`weeksUntil`'s „a DST boundary does not shift the count" was first written with
Europe/Bratislava, `today = 2026-10-20T12:00`, target `2026-11-03`. **It passed unchanged
when `weeksUntil` was mutated to naive `getTime()` subtraction.** CS-T2 §4 warned that an
assertion which does not name a timezone measures nothing; naming one is NOT sufficient.
Three things have to line up:

1. a named zone (this box is UTC, where both implementations are identical);
2. clocks **FORWARD**, not back — the autumn change makes the naive raw value LARGER, and
   with a midday `today` it rounds to the same day count;
3. a day count that straddles the **week** rounding. `Math.round(days / 7)` absorbs a
   one-day error nearly everywhere; **11 → 2 weeks vs 10 → 1 week** is one of the few
   places it does not.

Shipped fixture: `2026-03-22T12:00` → `2026-04-02` across the 2026-03-29 spring change —
11 calendar days, naive measures 10.46 and answers ONE week. Mutation-proved, with two
non-vacuity neighbours (one day either side ⇒ 1 and 3).

The DISPLAY half needed its OWN zone and its own test: validation goes through UTC, display
is built from LOCAL midnight, and formatting the UTC instant instead prints the PREVIOUS day
in America/New_York (measured: „11. 9." and weekday index 5 instead of 6). Mutation-proved
separately. **Two rules, two zones, two tests — one test could not have caught both.**

### 7. `lib/dates.js` deliberately disagrees with `cycle-stages.js` about bad input

`fmtDay()` (17) returns `''`; `fmtDayMonth`/`fmtDate`/`fmtWeekdayDayMonth` return the **raw
string** (§UC-PI-002's words). Not an oversight: 17's builders drop a bad date because they
would otherwise compose a sentence around a hole, while here the date IS the rendered thing
and showing what the admin typed is more useful than showing nothing. A NON-string
(`null`, a number, an object) is not „a raw string" and yields `''`.

⚠ The `2026-02-31` trap is inherited, not re-derived: V8 parses it as **3 March**, so the
`^\d{4}-\d{2}-\d{2}$` shape check is followed by the same UTC round-trip 17 uses. The test
asserts the trap itself (`new Date('2026-02-31T00:00:00').getDate() === 3`) before asserting
the refusal, and carries a non-vacuity line (`2026-02-28` formats).

### 8. The payload extension, and why a defaults-only assertion proves nothing

`orderPaid` / `orderHandedOver` both default to `false`, so „they are false with no order"
is satisfied by a route that reads NEITHER column. The test therefore drives both through
their REAL admin routes — submit → items packed → order packed → `handed-over` → `paid` —
and reads the friend payload back on **both edges**, un-hand-over and un-paid included.
Mutation-proved: `orderHandedOver = false` reds that test alone; dropping
`c.parcel_enabled` from the SELECT reds the five-columns test alone.

⚠ The additive claims are re-asserted beside it, because they are what a careless SELECT
edit takes out: `ORDER BY c.created_at DESC` (as NON-INCREASING — `created_at` is
second-resolution and SQLite leaves ties unspecified, so a re-sorted comparison would
flake), the `_placeholder` exclusion, `roundMoney` on `orderTotal`, and the subscription
filter — the last one with the discriminating half nobody writes: a bakery-only subscription
must still show the ordered COFFEE round (`hasOrder` wins) **and** must hide an un-ordered
one, or the first assertion is about a no-op.

### 9. Small things measured rather than assumed

- The three new routes carry **no auth guard**, deliberately: an anonymous visit must show
  the login card on the SAME URL so that logging in lands on the view that was asked for.
  Pinned per path.
- `view` and `landing` are `computed`, in the SESSION. Being computed is part of the
  boundary rule, not a style choice: they hold no value of their own, so there is nothing
  for a logout to fail to clear. Source-pinned both ways (`FriendPortal.vue` must contain
  none of `resolveLanding` / `portal-state` / `portal-landing` / `route.meta`; the session
  must contain no plain `<script>` block).
- `data-view` / `data-landing-state` exist so §UC-PI-001 and §UC-PI-002 are assertable
  through the real app WHILE their views are still being built. Neither is user copy.
- The DOM resolver tests stub `**/api/friends/cycles*` with `page.route` and **wait for the
  response** before reading `data-landing-state` — `cycles` starts EMPTY on a restore, so
  the pre-load reading is `closed` and a `closed` expectation could otherwise pass for
  entirely the wrong reason. The `open` / `locked` rows are what make the set
  discriminating, since neither is the pre-load value.
- `self-hosted-fonts.spec.js`: the three routes join BOTH the allowlist and the route sweep,
  with `/`'s allowance (they render the same login card anonymously) and not one host more.
  The `cycle-date` reference in the Figtree-700 probe comment was stale in half a sentence —
  struck in place, the probe untouched, and the enduring Figtree-700 surface inside
  `portal-landing` named instead (`.btn` / `.tab` / `.field-lbl` / `.pspec`).

### 10. Mutations run (all reverted from a scratchpad copy, never `git checkout`)

| # | Mutation | Reds |
|---|---|---|
| M1 | `data-testid="portal-landing"` on `FriendPortal.vue`'s `.app` root | 10 — incl. „absent anonymous" and the parent source pin |
| M3 | `nextText` re-implemented with `fmtDayMonth` | 3 — the delegation test, the junk-input fallback, the source pin |
| M4 | `orderHandedOver = false` unconditionally | the both-ways payload test, alone |
| M5 | `c.parcel_enabled` dropped from the SELECT | the five-columns test, alone |
| M6 | `view` hardcoded to `'shop'` | the four-routes test, alone |
| M7 | `weeksUntil` on naive `getTime()` subtraction | **NOTHING at first** (see §6); reds the rebuilt spring-forward test |
| M8 | display formats the UTC instant | the negative-offset test, alone |
| M9 | the marker deleted | 3 of 12 in `modern-login.spec.js` — the retarget still gates |

### What PI-T1 LEAVES BEHIND

1. ⚠ **The date-format conflict (§1) is a PO decision, not a defect with an owner.** Until
   it is taken, PI-T4's closed modal prints both forms. Do not resolve it at a call site.
2. **`e2e/helpers/portal.js` is half-written on purpose** (§4) — PI-T2 owns
   `openMenu`/`menuGo`/`logout`/`openProfile`/`openInvite`, in that file.
3. **The `Objednávkové cykly` heading still exists**, in `FriendPortalSession.vue` and in
   `portal-cycles.spec.js` / `portal-share-row.spec.js`. PI-T3 retires all three together;
   nothing gates on it any more, which is what makes that deletion safe.
4. **`resolveLanding` returns a sixth key, `nextOpening`** (`{ date, inWeeks, text }`,
   17's pieces), beyond the five §UC-PI-002 names. It exists so PI-T4's closed modal can set
   the date in display type on its own line without splitting the sentence string. Published
   shapes GROW.
