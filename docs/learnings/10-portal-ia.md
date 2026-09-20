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

---

## PI-T2 — the appbar per state, `NeoDrawer`, `useModalLayer()`, the A13 canon sync (2026-09-20)

**What shipped.** `components/neo/use-modal-layer.js` (extracted verbatim out of
`NeoModal.vue`); `components/neo/NeoDrawer.vue`; six `I2` glyphs in `icons.js` plus two
optional `linecap`/`linejoin` keys threaded through `NeoIcon.vue`; the **A13** canon sync of
`portal2.css` into `friends-theme.css`; the appbar rewritten per §UC-PI-003 in
`FriendPortal.vue` (reading a `computed` the session exposes); `menuOpen`, the
session-level balance fetch, the six drawer rows and `backHome()` in
`FriendPortalSession.vue`; five new helpers in `e2e/helpers/portal.js`; a new
`portal-menu.spec.js`; and the sanctioned retargets across **9** shipped spec files.

### 1. ⚠ THE EXTRACTION WAS PROVED BY DIFF, NOT BY A GREEN SUITE

`NeoModal` has **17 mount sites in 8 files**, and every one of them depends on five
behaviours that are 300 lines of hard-won comments. "The tests pass" is not evidence that a
move of that code is behaviour-preserving — it is evidence about the cases the tests cover.

So the move was made mechanically and then *checked* mechanically: strip comments and blank
lines from the OLD code (the plain `<script>` block + the per-instance block), apply the
four substitutions the parameterisation requires, sort both sides, and diff as multisets.
**106 statements in, 107 out, and the whole difference is three lines:**

```
+export function useModalLayer(el, { closable, trapping, onClose, tag = 'NeoModal' } = {}) {
-if (document.activeElement === el) return true
+if (document.activeElement === node) return true
```

i.e. the new wrapper signature, and the one loop variable renamed out of the way of the
`el` parameter. The substitutions themselves are the whole API: `props.closable →
closable()`, `trapping.value → trapping()`, `emit('close') → onClose()`, `modalEl → el` —
the first two are GETTERS precisely so that "read at event time, never captured" (which
three of NeoModal's comments insist on) survives the move.

### 2. THE BEHAVIOUR/TEST MAP — AND THE FOUR BEHAVIOURS NOTHING PINS

Written out because half of it is a finding, not a checklist:

| Behaviour | The test that reds if it breaks | Mutation |
|---|---|---|
| body scroll LOCK | `modern-login` "cannot be dismissed", `product-photo-lightbox` "(1) it is on the NeoModal shell", `portal-menu` "scroll-locked" | M1 |
| **Esc honours `closable`** | **NOTHING** (see below) | M2 |
| scrim mousedown ORIGIN + one-shot | `portal-profile-modal` "a text-selection drag out of .m-body must NOT close", `portal-menu` "a drag that STARTS inside" | M3 |
| focus TRAP | `modern-login` "Tab and Shift+Tab cannot escape the gate", `portal-menu` "cannot escape the drawer" | M4 |
| lock RELEASE (the counter) | `modern-login` "setting a valid password closes the gate" (`overflow === ''`), `product-photo-lightbox` | M1 covers |
| **restore to the SAVED value, not `''`** | **NOTHING** | M5 |
| **focus moved INTO the dialog on mount** | **NOTHING** | M6 |
| **focus RESTORED to the opener on close** | **NOTHING** | M7 |
| **the `didLock` mount/unmount pairing guard** | **NOTHING** | — |
| **the dev-only "more than one modal" warning** | **NOTHING** | — |

Mutations M1–M4 each red exactly the predicted tests and nothing else: M1 → 3
(`modern-login` "cannot be dismissed", `portal-menu` "scroll-locked",
`product-photo-lightbox` "on the NeoModal shell"); M3 → 4 (the `portal-menu` drag test plus
all three `portal-profile-modal` scrim-drag tests, including the capture-phase and
non-primary-press ones); M4 → 2 (both trap tests). M2 → **0**, see below.

⚠ **M2 IS THE SURPRISE, AND IT IS A PRE-EXISTING GAP, NOT A REGRESSION.** Deleting
`if (!closable()) return` from the Escape branch — i.e. letting Esc dismiss the forced
password-change GATE — reds **nothing**: `modern-login` runs 12/12 green. The reason is that
the gate's `<NeoModal :closable="false">` binds **no `@close` listener at all**, so the
emit lands nowhere. `modern-login`'s "Esc must not dismiss it" assertion is therefore
satisfied by the parent, not by the guard it looks like it is testing. `NeoModal`'s own
comment ("`closable: false` kills ×, scrim-close and Esc") is true of the × and the scrim —
both go through `requestClose()`, which IS guarded and IS pinned — and currently only
incidentally true of Esc. Nothing is broken; the guard is correct and must stay, because the
next `closable:false` consumer that DOES bind `@close` would dismiss on Esc without it. It
is simply not the thing that test measures.

M5+M6+M7 were applied TOGETHER and the four files that exercise modals stayed green — which
is the finding stated as a measurement rather than as a suspicion. **Those three were
already unpinned before this row**; the extraction did not weaken them, and this table is
the first time anyone has said so out loud. They are cheap to pin (an `activeElement` read
after a close; a `document.body.style.overflow = 'scroll'` prelude) and are left as named
work rather than smuggled into an unrelated row.

### 3. THE APPBAR HAD TO READ SESSION STATE WITHOUT HOLDING IT

`BrandChrome` is ONE instance across all three auth states (03 §UC-FL-001 — it must not
remount on login), so it lives in `FriendPortal.vue`. But §UC-PI-003's subtitle, ticker and
lock chip are functions of `route.meta.view` and of `resolveLanding(cycles)` — session data,
and PI-T1's source pin forbids `route.meta` in the parent outright.

The shape that satisfies both: the session exposes ONE `computed`, `appbar`, and the parent
reads it as `computed(() => session.value?.appbar || null)`. The parent stores nothing; when
`authState` leaves `authenticated` the session is destroyed, `session.value` is `null`, and
the login chrome renders by construction. `backHome()` is exposed for the same reason —
keeping the parent router-free is what keeps the "no `route.meta` here" pin meaningful
rather than incidental.

### 4. ⚠ THE `.s` LINE WAS AN IDENTITY ASSERTION IN FOURTEEN PLACES, AND THE SPEC NAMED FIVE

§UC-PI-019 items 4/5 enumerate the logout and `.titles` call sites. Measured, the retarget
was bigger in two directions:

- **`portal-shell.spec.js` is in NEITHER list** — it is PI-T1's own file, written after the
  spec, and it carried 4 logout clicks and 2 `.appbar .titles .s` identity pins. Same class
  as PI-T1's `payment-links.spec.js` finding, one row later: *re-enumerate, never trust the
  enumeration*.
- **`.appbar .titles .s` was the friend's NAME**, and §UC-PI-003 turns it into a fixed
  per-view subtitle. That is not in items 4/5 at all, and it appears as
  `.titles .s`-toHaveText (5 sites) AND as `expect(page.locator('.appbar')).toContainText(name)`
  (8 sites, in `google-auth` ×7 and `magic-link` ×1) — the second shape invisible to a grep
  for the first.

All thirteen now go through ONE helper, `expectChromeName(page, name)`, which opens the
drawer, asserts the header and closes it again. **The claim moved with the name, not with
the selector.**

⚠ **And it has a limit worth knowing before the next row hits it:** the hamburger sits
behind any open `NeoModal`'s scrim, so `expectChromeName` (and `logout`, and `openProfile`)
cannot be called while a dialog is up. Three `google-auth` sites asserted identity while the
Google link prompt was open; the fix was to make the claim ONE STEP LATER, after the prompt
is dismissed, in the same document. The tempting alternative — reading `friendName` out of
`localStorage` — was written, run, and **failed**: `loginInPlace()` does not tick
"remember me", so there is no stored payload at all. A weaker assertion that also happens to
be wrong is the worst of both.

### 5. THE A13 CANON SYNC: VERBATIM, WITH TWO DEVIATIONS RECORDED IN THE FILE

`portal2.css` ported as a trailing section, byte-for-byte, with exactly two departures, both
written into the A13 block rather than reconciled silently:

- **D1 — `.p2-icobtn` also gets a `.modal-layer` scope.** The prototype writes `.app
  .p2-icobtn` only, because ITS modal layer is a node inside `.app`; in production the layer
  is teleported OUT (02 §UC-DS-001 A6/A8). The prototype selector therefore reaches the
  appbar's hamburger but NOT the drawer's ×, which would render as a bare 18px glyph — under
  UC-DS-005's 44px minimum. Grouped into one declaration block, prototype specificity (0,2,0)
  kept. **Pinned** by a `boundingBox()` assertion in `portal-menu.spec.js`, and
  mutation-proved by reverting the selector (M14).
- **D2 — the two TIMELINE blocks (`.p2-tl`, `.p2-dots` — **19 rule blocks / 24 comma-separated
  selectors**, measured; the first write-up said „15 selectors", which was neither) are NOT ported.**
  CS-T2 already shipped that component as `CycleTimeline.vue` with `.cs-` scoped styles
  (17 §UC-CS-006, and §UC-PI-019 item 13 already records the rename). Porting them would add
  fifteen selectors matching nothing AND a second home for how the timeline is painted.

The rest of the file (`.p2-lines`, `.p2-tot`, `.p2-step`, `.p2-hl`, `.p2-ro`, `.p2-tx`) is
ported now although PI-T2 uses none of it: **a canon sync is one act**, and PI-T4/5/7/8 are
its consumers. They must not re-port their slice.

⚠ A10 note: the drawer HEADER's friend-name div carries no class, so it takes A10's
documented call-site remedy (`line-height:normal` inline) — the case a class list
structurally cannot reach.

### 6. `getByRole('dialog')` — 30 FILES, AND WHY `v-if` IS LOAD-BEARING TWICE

The drawer is `role="dialog" aria-modal="true" aria-label="Menu"`. **Measured: 30 spec files
and 206 occurrences of `getByRole('dialog')`.** Rendered-but-hidden, the drawer would make
every unscoped one of those a strict-mode violation. The parent mounts it with `v-if`, so it
is in the DOM only while open; `portal-menu.spec.js` pins that in both directions (count 0 →
1 → 0, and the profile modal still resolving to exactly ONE dialog with the menu closed), and
M8 (`v-if` → `v-show`) reds it.

Verified by running 13 of the 14 friend-facing dialog-counting files, not by argument. The
corollary is now in `CLAUDE.md`: a spec that counts dialogs while the menu is open is
counting the menu.

### 7. Small things measured rather than assumed

- **`menuGo()` returns BEFORE the router has navigated.** §UC-PI-004 says "close the drawer
  first, then act", so the drawer is gone while `router.push` is still a microtask away. Three
  tests read `page.url()` once and got `/` instead of `/moje-objednavky`. The rule: assert a
  URL with a RETRYING matcher (`expect(page).toHaveURL(...)`), never with a one-shot read —
  and the helper deliberately does NOT wait for navigation, because two of the six rows open a
  modal and navigate nowhere.
- **The ticker is uppercased in JS, not by CSS.** `.ticker` is `text-transform:uppercase`, and
  `toContainText` resolves from `textContent`, which does not apply a transform. A lower-case
  source would look right on screen and red here — M10 proves the direction.
- **`weeksUntil` (18) and `inWeeksText` (17) genuinely differ** and the ticker uses 18's:
  17's builder switches to DAYS under a week (PO O6), while §UC-PI-003 specifies
  weeks-or-„DÁME VEDIEŤ". Two rules, and the split is by SENTENCE (PI-T1 §1), not by taste.
- **The `.s` subtitle for a LOCKED round is state-dependent in two ways**: „Vaša objednávka"
  only when the friend has an order in it, „Aktuálna ponuka" otherwise. Both branches are
  pinned, because a one-branch fixture would pass against a component that ignored `hasOrder`.
- **The legacy login card lists every friend by name** in its „Vyberte svoje meno" dropdown,
  so `expect(body).not.toContainText(otherFriendsName)` is UNSATISFIABLE on the login screen.
  That assertion was written, failed, and moved to the next session's chrome, where it is
  both satisfiable and discriminating.
- **The subtitle rewrite broke the „explainer has no hamburger" assumption in PI-T1's own
  file**: `portal-shell`'s four-view walk ends on `/ako-to-funguje`, where §UC-PI-003 puts a
  back chevron instead of the menu. The test now returns to `/` first — the swap is the spec,
  not a workaround.

### 8. The mutation matrix, in full (all reverted from a scratchpad copy, never `git checkout`)

| # | Mutation | Reds |
|---|---|---|
| M1 | the scroll lock never writes `overflow:hidden` | 3 — `modern-login`, `portal-menu`, `product-photo-lightbox` |
| M2 | Escape ignores `closable()` | **0** — §2: the gate binds no `@close` |
| M3 | the scrim click drops the origin/one-shot check | 4 — `portal-menu` drag + all 3 `portal-profile-modal` scrim tests |
| M4 | the focus trap never runs | 2 — both Tab-escape tests |
| M5+M6+M7 | restore-to-`''`, no focus-on-mount, no focus-restore | **0** (four files, 68 tests) |
| M8 | the drawer mounted with `v-show` | **27** — every `portal-menu` test plus 8 in `portal-appbar` (a second permanent dialog breaks the whole file) |
| M9 | the lock chip is also `.chip.acc` | 1 — the state-ticker/lock test |
| M10 | the ticker suffix is not uppercased in JS | 1 — the same test (run SEPARATELY from M9, so each is covered on its own) |
| M11 | badge threshold `< 0` instead of `< -0.01` | 1 — the badge test |
| M12 | „Moje objednávky" counts all rounds, not `hasOrder` | 1 — the item-2 test |
| M13 | the balance is fetched per drawer OPEN | 1 — the fetched-ONCE test |
| M14 | A13 deviation D1 reverted (`.app`-only `.p2-icobtn`) | 1 — the ×-hit-target assertion in the close-paths test |

⚠ M9 and M10 were first run TOGETHER and reddened ONE test — which cannot distinguish them,
because that test asserts both. They were re-run separately for exactly that reason; a
combined mutation is only evidence when it reds disjoint tests (as M11–M14 did, 1:1).

### What PI-T2 LEAVES BEHIND

1. **TWO balance requests per session load**, and it is deliberate: `FriendBalanceCard.vue`
   still makes its own (module 03's card is still on the landing). PI-T7 relocates that card
   and feeds it from the session's `balance` ref, at which point §UC-PI-004's "one request per
   session load" is literally true. The per-OPEN rule — the half this row owns — is pinned now.
2. **Item 4 („Zdieľať s kolegami") and item 1's „ · v košíku {suma}" clause are PI-T3's.**
   Both need things that do not exist yet (the share dialog re-pointed at the landing; a
   landing cart). The empty slot between items 3 and 5 is PINNED empty in `portal-menu.spec.js`
   so filling it is a deliberate edit.
3. ⚠ **A SPEC DISCREPANCY, recorded rather than resolved silently.** §UC-PI-004's `.on` rule
   says „the item whose view is current gets `.on`" and its parenthetical says „(only items
   1/2/6 map to a view)" — but item 3's action IS a view (`/zostatok`, `meta.view: 'balance'`).
   FOUR rows map, not three; the prototype agrees. Implemented as the general rule.
4. **Four `useModalLayer` behaviours have no test at all** (§2). Naming them is the deliverable;
   pinning them is a row someone should schedule.
5. **`icons.js` grew two optional keys** (`linecap`, `linejoin`) because the `I2` glyphs set
   them and the original fourteen do not. PI-T8 and GL-T4 add the remaining I2 glyphs to THAT
   file — `cup`, `box`, `hand`, `truck`, `pin`, `pause`, `bell` — never a second icon module.
