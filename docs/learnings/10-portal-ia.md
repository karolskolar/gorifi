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

---

## PI-T3 — the landing IS the order screen; two spec files deleted (2026-09-20)

**What shipped.** `FriendOrder.vue` extended with `mode='landing'` (props `cycleId` /
`friendId` / `mode`, `defineExpose({ openShareDialog, cartTotal })`, the cartbar share
icon, „Späť na ponuku" / „Skúsiť znova"); `FriendPortalSession.vue` mounts it on `/` in
the OPEN state under a new status line, and RETIRED the cycle list, the gear, the
subscription modal, the archive fold, the share row and its own `GuestShareDialog`;
`FriendPortal.vue` dropped the handshake's `subscriptions` fetch; drawer item 4 and item
1's „ · v košíku" clause; `helpers/portal.js gotoCycle()`; NEW `portal-landing.spec.js`;
**`portal-cycles.spec.js` and `portal-share-row.spec.js` DELETED.**

### 1. ⚠⚠ THE MIGRATION TABLE — 32 tests deleted, and where each property went

Written before a line was deleted, and it is the deliverable of this row.

| Describe (file) | Verdict | New home |
|---|---|---|
| heading `<h2>` + magenta highlight (cycles) | retires | the „portal is ready" gate moved to `expectLanding()` in PI-T1 |
| the gear opens the subscription modal (cycles) | retires | its ABSENCE is pinned — `portal-subscription-invite` pin 1 |
| both empty states (cycles) | retires | landing empty copy is PI-T4's „Ponuka ešte nie je pripravená." |
| one `div.p-4` per cycle · share button inside it · `.card.hl` · fonts · order total · navigation (cycles ×6) | retire | — the card is gone; navigation became `helpers/portal.js gotoCycle()` |
| badge matrix ×3 (cycles) | retires | PI-T6 owns history's OWN badge vocabulary (§UC-PI-009 — deliberately not shared) |
| archive fold ×4 (cycles) | retires | PI-T6's „Moje objednávky" |
| list geometry ×2 (cycles) | retires | `portal-fidelity`'s document-level 320px claim; PI-T12 adds landing equivalents |
| „N kolegovia · X kg" + declension + trailing zeros + no-item-rows + zero/failed (share-row ×4) | **SURVIVE** | `portal-menu` §1b — item 4's sub-line, four tests |
| the count fetch hits OPEN cycles only (share-row) | **SURVIVES, stronger** | `portal-menu` §1b — ONE request, for the current round, with 40 open rounds |
| row geometry at 378px · 320px overflow (share-row ×2) | retire | the row is gone |
| locked/planned ⇒ no share affordance (share-row) | **SURVIVES** | `portal-landing` §3 — no cartbar icon, no drawer row, both states |
| `@click.stop` opens the dialog without navigating (share-row) | **SURVIVES** | `portal-landing` §3 — the cartbar icon, URL stays `/` |
| the count is context only — gates nothing (share-row) | **SURVIVES** | `portal-landing` §3 — a failed count still leaves row + dialog working |
| counts do not survive a logout (share-row) | **SURVIVES** | `portal-menu` §1b |
| a response deferred past a LOGOUT is dropped (share-row) | **SURVIVES** | `portal-menu` §1b |
| a response deferred past a SECOND `loadCycles` (share-row) | ⚠ **NO NEW HOME — a finding** | see §2 |
| the fan-out is BOUNDED, cap 3 + ordering (share-row) | **SURVIVES, stronger** | `portal-menu` §1b — ONE, plus the ordering half verbatim |

**Delta: 2186 → 2169 tests, 89 → 88 files** (measured with `npx playwright test --list`
before and after, per file — a total alone would let a loss hide behind a gain):

| file | before | after |
|---|---|---|
| `portal-cycles.spec.js` | 18 | **deleted** |
| `portal-share-row.spec.js` | 14 | **deleted** |
| `portal-landing.spec.js` | — | **14** (new) |
| `portal-menu.spec.js` | 19 | 28 (+9, §1b) |
| `portal-subscription-invite.spec.js` | 14 | 7 (−9 subscription describes, +2 replacement pins) |
| `portal-fidelity.spec.js` | 11 | 9 (−2, §UC-PI-019 item 13) |
| `order-cartbar.spec.js` | 14 | 15 (+1, the landing variant) |

−32 −9 −2 +14 +9 +1 +2 = **−17**. Every other edited file kept its count exactly.

### 2. ⚠ THE ONE PROPERTY WITH NO NEW HOME, SAID OUT LOUD

„A count response deferred past a SECOND `loadCycles` in the SAME session is dropped."
Its only trigger was `saveSubscriptions()`, which was `loadCycles()`'s only caller, and
§UC-PI-016 retires the gear that reached it. `cycles` is loaded once per session now, so
there is **no second batch to supersede and nothing can red that branch**. The counter and
its guard are KEPT in `FriendPortalSession.vue` with a comment saying exactly this, so the
next in-session reloader (PI-T6's history, a post-submit `hasOrder` refresh) inherits the
protection rather than re-discovering the race.

⚠ And the related measurement is worth more than the finding: **M13 — deleting the
`if (seq !== guestCountSeq) return` guard entirely — reds NOTHING**, because the parent's
`v-if` + `:key` destroys the instance and a late write lands on a dead ref. It takes
M12 (`colleagues` hoisted to module scope **and** the guard removed) to red the two
session-scoping tests. The guard and the component boundary are genuine defence in depth;
today only the boundary is load-bearing. Same shape as PI-T2 §2's M2.

### 3. ⚠⚠ THE ENUMERATION WAS WRONG FOR THE FOURTH ROW RUNNING — AND THIS TIME BY 20 FILES

§UC-PI-019 item 3 names „`guest-link.spec.js:255`, `catalog-admin.spec.js:2419`, and any
hit of \[a grep]". The backlog row copied the two names. **Measured: the grep hits TWENTY
spec files**, because `page.goto('/')` + `getByRole('heading', { name: cycle.name, exact:
true }).click()` was the ONLY in-app route to an order screen, and every order-surface spec
used it: `cat-scroll-arrow`, `colleagues-panel`, `guest-host-view`, `guest-link`,
`guest-order-recovery`, `guest-payment-modal`, `catalog-admin`, `money-rounding`,
`order-cartbar`, `order-fidelity`, `order-locked`, `order-modals` (×4), `order-product-card`,
`order-shell`, `payment-links`, `product-desc-font`, `product-photo-lightbox`,
`share-dialog`, `mobile-no-h-overflow`.

⚠ **And the backlog's „`share-dialog.spec.js` unmodified" was not merely optimistic — it
was unsatisfiable.** That file's entry point B is `portalCard()` = the cycle card. So is
`guest-order-recovery.spec.js`'s, which **NO list names at all** and which a
`grep "div\.p-4"` MISSES because it writes `div.card.p-4`. Two enumeration misses in one
row, from two different grep shapes. The rule, restated for the fifth time: **re-enumerate
with the WIDEST pattern, then read the hits.**

### 4. ⚠⚠ `page.goto('/cycle/:id')` DOES NOT WORK, AND §UC-PI-019 ITEM 3 SAYS TO USE IT

Item 3's prescribed replacement is „`page.goto('/cycle/${id}')` + the shipped URL
assertion". It cannot work: the friend's Bearer token lives in **memory only**
(`api.js setFriendsToken`), `FriendPortal.vue` is its single owner, and `FriendOrder.vue`'s
`onMounted` therefore BOUNCES a cold deep link to `/` — which is exactly why all twenty
files went in through the portal in the first place.

`helpers/portal.js gotoCycle()` uses that bounce instead of fighting it:

1. `goto('/cycle/:id')` — the app bounces with `router.push('/')`, a same-document
   `pushState`, so history is `[/cycle/:id, /]`;
2. wait for the portal — that is the session restoring the token into memory;
3. `goBack()` — a same-document traversal back to entry 1, handled by vue-router as a
   client-side navigation. `FriendOrder` mounts with the credential already in memory and
   does not bounce.

No app change, no new auth path. ⚠ **Its one cost, and it bit two tests:** `/cycle/:id` is
now the BOTTOM entry of its document, so `page.goBack()` from the order screen leaves the
document (`about:blank`) instead of popping to `/`. `order-locked` and `order-modals` both
tested „a history traversal the chevron does not own runs through `onBeforeRouteLeave`";
both now use **`goForward()`**, which is the same router navigation, the same guard and the
same assertions. `goBack()` there would prove nothing.

### 5. ⚠ THE CARTBAR SHARE ICON IS LANDING-ONLY, AND TWO IMMUTABLE SPECS DECIDED IT

§UC-PI-005 introduces the icon under „Landing composition" and §UC-PI-011 calls the two
triggers „the cartbar icon + the drawer item"; neither says what `/cycle/:id` does. The
answer is forced: `guest-host-view.spec.js:890,929` and `share-dialog.spec.js`'s mount-seam
test both assert an **unscoped** `getByRole('button', { name: /Zdieľať/ })` on the deep
link — `toHaveCount(0)` on „Moja objednávka", `toHaveCount(1)` on „Kolegovia". An
always-visible icon named „Zdieľať s kolegami" makes those 1 and 2. **Mutation M11 (drop
the `v-if="isLanding"`) reds 10 tests across both files**, which is the evidence.

### 6. ⚠⚠ A REAL DEFECT THE SANCTIONED `order-cartbar` LANDING VARIANT CAUGHT

`.cartbar` is `position:sticky; bottom:0`, and **a sticky element may never be shifted
above its containing block's top edge.** Mounted inside a real wrapper `<div>`, the bar's
containing block began at the embedded subtree (y=281 at 378×420), so it clamped at **435
against a 420px fold** — the landing silently lost the sticky footer that `/cycle/:id` has,
on short screens only. The fix is `display:contents` on the landing-mode wrapper: no box,
so the containing block is the session's page column (y=124) and the bar reaches the
viewport bottom exactly as on the deep link. Measured 420 in all four positions
(first paint, scrolled, back at top, after a reload); M6 (revert it) reds the test alone.

⚠ The shipped test above it pins `parentIsApp === true`, which is the DEEP LINK's shape and
is precisely what this row moves away from on `/` — so it could not have caught this. A
geometry rule restated as a Tailwind utility (or moved into `FriendOrder`'s
`<style scoped>`) would keep working on `/cycle/:id` and un-stick the screen a friend now
lands on.

### 7. ⚠⚠ THE „ONE `GuestShareDialog`" RULE HAS NO DOM SIGNATURE — IT NEEDED A SOURCE PIN

M1 mounts a SECOND `GuestShareDialog` in the session and points the drawer at it. It reds
**one** behavioural test (the from-another-view one, which needs the exposed opener) and
**none** in `share-dialog.spec.js`: the dialog is `v-if="open"`, so the extra instance is
invisible while closed, and when the drawer opens ITS copy the screen shows one dialog with
the right title and the right cycle name. The defect the rule exists for — one instance
silently stopping receiving updates — has no observable signature until the two disagree,
which is a state a test cannot reach on purpose.

So it is pinned in the SOURCE, per FILE (`FriendOrder` 1, `FriendPortalSession` 0,
`FriendPortal` 0 — a total would let „moved from A to B" pass), plus the bridge itself
(`defineExpose({ openShareDialog })` ↔ ~~`landingOrder.value.openShareDialog()`~~ **GL-T6c:
`shareHost.value.openShareDialog()`, `shareHost` = whichever of `landingOrder` / `lockedOrder` /
`closedOrder` is mounted — learnings 11 §GL-T6c; the per-file counts are unchanged**).

⚠ **And the source-pin helper lifted from `portal-shell.spec.js` was BROKEN on a `.vue`
file.** It strips `/* */` before `//`, and `FriendPortalSession.vue:56` carries the line
comment „No `@/components/ui/*` import remains in this file" — whose `/*` opens a block
comment the strip then closes **16 709 characters later**, swallowing a third of the file.
M1's mount landed in that hole and the pin stayed green. Line comments now go FIRST, and
every absence pin sits behind an `assertReadable()` gate (stripped length > 30 % of raw,
plus named tokens) so the next such hole is loud. **Any spec that greps `.vue` source
inherits this trap.**

### 8. Small things measured rather than assumed

- **`GuestSubOrders.vue` makes its OWN `GET /guest-links/cycle/:id`,** and it is mounted on
  the landing (the Kolegovia panel is `v-show`). So „exactly ONE count request" can only be
  measured on a view where the embedded `FriendOrder` is NOT mounted — every test in
  `portal-menu` §1b runs on `/zostatok` for that reason, and it is written at the top of the
  block. The same fact is why `portal-landing`'s „a failed count gates nothing" test does
  **not** assert „no banner anywhere": that stub fails module 05's fetch too.
- **The ONE-request test asserts the SET of ids requested, not the count.** A re-introduced
  fan-out asks for 40 ids; a cap of 3 still asks for 40. (First draft wrapped `created_at`
  at `i % 28`, so row 27 was newest and the test „failed" on a perfectly correct single
  request — `resolveLanding` sorts `created_at DESC, id DESC`, never by id.)
- **Slovak declension is a real assertion, not a formatting detail:** „4 kolegovia" but
  „5 kolegov" (genitive plural from five up), and „do **piatku**" — `fmtWeekdayDayMonth`
  returns the weekday ALREADY declined. Two of my first drafts were wrong in exactly these
  two places, which is the argument for fixtures at 1, 4 and 5.
- **Drawer item 4's condition is the landing STATE, not the VIEW,** so the row is offered on
  `/zostatok` too — where the one dialog is not mounted. `requestShareDialog()` therefore
  sets a pending flag, `router.push('/')`, and a `watch(landingOrder)` opens it once the
  instance exists. Pinned from `/zostatok`; the alternative (a second dialog in the session)
  is what §UC-PI-011 forbids.
- **`FriendOrder` is keyed on the cycle id on the landing.** It loads its order from
  `onMounted` only and has no watch on its cycle (a lifetime assumption recorded in its own
  header, PL-T4); re-pointing one instance at another round would keep the previous
  `order`/`cart`/`paymentVs`.
- **The handshake lost a request:** `beginSession()` no longer fetches `subscriptions`
  (§UC-PI-016 — the modal it prefilled is gone). The table, both routes and the SERVER-side
  filter are untouched, and the surviving endpoint is round-tripped in
  `portal-subscription-invite`'s replacement pin.
- `portal-appbar`'s voucher-geometry test located the page column as „the `.app` child
  holding an `<h2>`" — i.e. by the retired heading. Re-pointed at PI-T1's
  `[data-testid="portal-landing"]`, which is the one handle for that column and cannot be
  retired by a copy change.

### 9. The mutation matrix, in full (all reverted from a scratchpad copy, never `git checkout`)

| # | Mutation | Reds |
|---|---|---|
| M1 | the drawer mounts a SECOND `GuestShareDialog` | 2 — the from-another-view test + the SOURCE pin (see §7: the pin was needed) |
| M2 | the colleague-count fan-out restored (one GET per open round) | 1 — „ONE request for the CURRENT round" |
| M3 | `colleagues` hoisted into module scope (the six-leak shape) | 1 — „a count does NOT survive a logout" |
| M4 | the cartbar share icon navigates before opening | 3 — all three dialog-entry tests |
| M5 | the leave guard never fires | 1 — „the leave guard fires on the DRAWER's `router.push`" |
| M6 | `display:contents` reverted on the landing wrapper | 1 — „THE LANDING VARIANT" (§6) |
| M7 | item 4 renders on every landing state | 3 — the row-set test, the no-open-round test, „no share affordance" |
| M8 | cancelled sub-orders counted in the kilos | 1 — „a cancelled sub-order reaches neither figure" |
| M9 | the landing renders its own `.app` root | 1 — „ONE `.app` root and ONE chrome" |
| M10 | the sub-line always appends the kilos | 1 — „drops the „· " separator instead of printing „0 kg"" |
| M11 | the cartbar icon renders on the DEEP LINK too | **10** — `share-dialog` ×9 + `guest-host-view` ×1 (§5) |
| M12 | M3 **+** the seq guard removed | 2 — both session-scoping tests |
| M13 | the seq guard removed ALONE | **0** — the component boundary covers it (§2) |

### What PI-T3 LEAVES BEHIND

1. **The CLOSED and LOCKED landings render chrome, the balance card and nothing else** until
   PI-T4/T5. That is the planned increment, not an omission, and it is stated in the
   template where the branch is.
2. ⚠ **`portal-fidelity.spec.js` is two tests lighter** (§UC-PI-019 item 13): the cycle-card
   A10 block and the archive plain-text test retired with their structures. PI-T12 owes the
   landing equivalents — `.banner.slim`, `.badge`, `own-order-card .display`, `.cs-tl .lbl`
   — and they need PI-T4/T5 to exist first. **✔ DISCHARGED by PI-T12 §1 — and two of the
   four are not A10 sites (the canon declares them).**
3. ⚠ **`portal-session-boundary.spec.js`'s walk lost two stops** (archive fold, subscription
   modal) because both surfaces are gone. §UC-PI-019 item 14's drawer-based rewrite (history,
   balance, explainer) is still PI-T12's. **✔ DISCHARGED by PI-T12 §3.**
4. **`helpers/portal.js gotoCycle()` is the one home of portal → order navigation** (§4).
   PI-T11's `/cycle/:id` regression net builds on it; a spec that hand-rolls the bounce is
   re-creating the problem.
5. ⚠ **The deep link still bounces cold** (`FriendOrder.onMounted` → `router.push('/')`),
   which contradicts §UC-PI-018's acceptance criterion („`page.goto('/cycle/<open id>')` with
   a stored session ⇒ the order screen"). Shipped behaviour, untouched here; **PI-T11 owns
   the decision** — fixing it would also let `gotoCycle()` collapse to a plain `goto`.
6. **`FriendBalanceCard` is still on the landing and still makes its own balance request**
   (PI-T2's finding, unchanged): PI-T7 relocates it.

### 10. ⚠ THE FULL-SUITE SCARE, AND WHY IT IS NOT THIS ROW

TWO coordinator full runs with this work went red — **115 failed** and then **33 failed** —
against **2181 / 1** at HEAD, with the failures showing as admin **401**s on fixture setup
(`POST /api/friends`, `POST /api/cycles`) in fifteen files this row never touched. The
leading hypothesis was that deleting two spec files re-ordered the suite and exposed a
token dependency. It was not that, and it was not this row.

**Measured five ways, and it does not reproduce:**

| run | DB | box | result |
|---|---|---|---|
| coordinator, HEAD | clean | loaded | 2181 passed / 1 failed / 4 skipped · 14.5 min |
| coordinator, this row (1st) | **CORRUPT** | loaded | 1408 passed / **115 failed** / 642 did not run · 17.4 min |
| coordinator, this row (2nd) | clean | loaded | 2061 passed / **33 failed** / 70 did not run · 14.2 min |
| **this row, clean box** | clean | **idle** | **2165 passed / 0 failed / 4 skipped · 11.8 min** |
| coordinator re-run, this row | clean | **idle** | **2165 passed / 0 failed / 4 skipped · 11.9 min** |

Plus the first five files in suite order (95 tests, 8.1 s) and `admin-auth` +
`admin-friends-labels` alone (9 tests) — both green.

**⚠ A CORRECTION I OWE THIS FILE, because the wrong version of it was written here first.**
The original write-up argued „file order is not the mechanism, because the first failure
sits at test index 8 in BOTH red runs". **That is false and I had not earned it:** I had
read ONE of the two red logs. The first failure is at index **234** in the first red run
and at index **8** in the second — and the first run's server log carries **65
`disk image is malformed`** errors, so it was measuring a corrupted database rather than
any code at all. ⚠ This is the SAME enumeration failure §3 of this very write-up documents
twice (the spec's 2-file list that was really 20; the `div\.p-4` grep that missed
`div.card.p-4`) — **third instance in one row, and this one I committed myself, in the file
whose job is to stop it.** An enumeration is a measurement: read every input or do not
write the word „both".

**What actually carries the conclusion** (verified, and the only argument that should be
quoted): the first failure in the clean-DB red run is a **10 s timeout on the admin login
REDIRECT** (`toHaveURL(/admin\/dashboard/)` never fires), not a rejection. The backend
keeps ONE `admin_token` row and **every** `POST /api/admin/login` replaces it, so a login
whose response lands after its test gave up still rotates the row — and every spec file
that cached a token earlier then 401s on its next fixture. The suite mitigates this by
CONVENTION, per file (`colleagues-panel.spec.js`: „Every fixture-building block re-logs-in
first"), and the convention has gaps. Under load the gaps open.

**⚠⚠ THE ROOT CAUSE, found by the coordinator and worth more than the rest of this section.**
Four stale `bash` wait-loops from earlier rounds of this row were still spinning: they poll
`pgrep -f "playwright test"`, and a watcher's own `bash -c` command line CONTAINS that
string, so each one matched itself and never exited. They had been loading a two-core box
for hours. It is the `pkill -f` self-match rule this repo already documents, with a worse
ending — `pkill` fails loudly, this fails SILENTLY and degrades every later run. Kill them
and the suite goes green. Poll the LOG for a summary line, or use a bracket class the
watcher cannot contain (`pgrep -f "[p]laywright test"`). Recorded in `CLAUDE.md`.
**The generalisation: a full run that takes ~14 min where it usually takes ~12 is already
telling you the box is the variable. Check the box before blaming the diff — and read the
SERVER log before the test log, which is where `disk image is malformed` was sitting in
plain sight.**

⚠ The amplifier that was suspected — a 401 driving the admin SPA to call
`POST /api/admin/logout` and DELETE the row — **does not exist**: all four `logout()`
callers are „Odhlásiť sa" button handlers. Mid-run the row is only ever rotated, never
deleted. Checked, so the next person does not re-derive it.

Every loaded-box run took 14.2–17.4 min; both idle-box runs took 11.8 and 11.9 — i.e. the
extra requests the landing issues (`FriendOrder` + `GuestSubOrders` now load on every `/`)
did **not** slow the suite down, which is the other thing worth having measured.

**Conclusion: environmental, and the fragility it exposed is pre-existing — not this row.** The fix is a harness one and belongs
in its own row — an admin helper that re-authenticates once on a 401 instead of trusting a
cached token. Two constraints for whoever takes it: `api-security.spec.js` tests token
staleness ON PURPOSE and must be excluded, and `google-auth.spec.js` already re-auths on a
401 and is the shape to lift. It must ship with a DETERMINISTIC reproduction (rotate the
row mid-file, show the helper recovers) — a harness change made against a failure nobody
can reproduce is the unfalsifiable kind this file keeps warning about.

### 11. ⚠ THE REVIEW: three majors, and two of them were my own findings left half-applied

`revise`, and the reviewer re-derived the migration table from the deleted files at HEAD
rather than from my report, ran five mutations of its own, and confirmed every surviving
property reds. What it found that I had not:

**Major 1 — a real user-facing defect the new leave-guard test could not see.**
`handleSuccessModalClose()` and `confirmCancelOrder()` set `leaveConfirmed = true` (a
ONE-SHOT guard bypass that only `onBeforeRouteLeave` disarms) and then `router.push('/')`.
On `/cycle/:id` that push really leaves, the guard runs and consumes the flag. **On the
landing the push is a NO-OP** — same route, no unmount, guard never runs — so the flag
stayed ARMED and silently swallowed the NEXT navigation's prompt. Measured on the built
app: submit → close → step a product → drawer ⇒ zero dialogs, URL changed, cart gone.
My `portal-landing.spec.js` leave-guard test passed throughout because it only ever
exercises the NEVER-SUBMITTED path, which never arms the flag.

Fixed with `leaveToOffer()` — ONE home for „go to `/` and do not ask" — which arms the
bypass **only when it is actually going somewhere** (`if (route.path === '/') return`).
*A guard armed by something that did not navigate is armed for the wrong departure.*
M14 (arm unconditionally) reds the new post-submit test alone.

**Major 2 — I rewrote the superseded claims in ONE copy and left three.** The
documentation-discipline rule („a superseded claim must be rewritten in EVERY copy") is
one I quoted in this very file and then broke. Amended in place, with strikes and
pointers: `18 §UC-PI-011` („`share-dialog.spec.js` passes unmodified" — it could not,
nine call sites moved), `18 §UC-PI-019 item 3` (both the 2-file enumeration that measured
20 AND the `page.goto('/cycle/:id')` prescription I proved cannot work), `PROGRESS.md:430`,
and `03-friend-login-portal.md` — which still documented the card, the `p-4` prohibition,
the gear, the archive fold and the subscription modal as LIVE, with a pin table naming two
assertions this row deleted. That file now opens with a supersession banner and a
UC-by-UC table.

**Major 3 — my own stripper finding, applied to one file out of two.** I diagnosed the
`ui/*`-in-a-line-comment hole, fixed it in `portal-landing.spec.js`, wrote the CLAUDE.md
rule — and left `portal-shell.spec.js:596` with the broken copy, pointed at the same two
`.vue` files. The reviewer measured it: a `localStorage.setItem` at line 200 of
`FriendPortalSession.vue` survived unseen, so that file's „no plain `<script>` block" and
„nothing persisted" pins were vacuous across lines 56–347.

Hoisted into `e2e/helpers/source-pins.js` (`read` / `code` / `assertReadable`), and both
specs re-pointed. ⚠ **Fixing the stripper was not enough, and that is the part worth
keeping:** the persisted-state pin also read
`session.split('resolveLanding')[0]` — and the FIRST `resolveLanding` in that file is its
IMPORT on line 70, so the slice being searched was lines 1–70 of a 2 600-line component.
M15 passed even with the stripper repaired. The correct scope is the WHOLE FILE, and it is
not a widening: every one of the ten `localStorage` mentions there is in a comment, so
after stripping the honest assertion is that the token does not occur at all. M15 now reds
at line 200 AND at line 2300 (the second hole, opened by the comment at `:2277`).

⚠ **And `assertReadable`'s gate had to be re-based on MEASUREMENT, not taste.** My first
version used a 0.3 length ratio; it red-lined `lib/portal-state.js` on a perfectly good
strip. Measured surviving fractions vary fourfold because this repo comments heavily —
`portal-state.js` 0.166, `dates.js` 0.290, the three big `.vue` files ~0.36, `router.js`
0.562 — so no ratio is both safe for `portal-state.js` and tight enough to catch a
16 709-character hole. The ratio is a CATASTROPHE backstop (0.05); the discriminating gate
is `mustContain`, tokens picked from the REGION the pins care about, and a caller that
passes none is refused.

**Minors.** (4) `pendingShare` is now disarmed on every path that does not reach the
instance — with the honest note that two of the three exits have no reachable trigger
today, and the reachable half (return to `/` must not re-open the dialog) is pinned.
(5) `portal-fidelity`'s hostile-text claim is RESTORED rather than retired: `expected_date`
is admin free text the landing renders verbatim, so the fixture weaponises it and the test
asserts `overflow-wrap:anywhere` on the status line plus the document claim — M16 (drop
the property) reds 3 tests. (6) The orphan em dash is gone — the dash belongs to the „Káva
príde" clause, and ⚠ moving it exposed that Vue CONDENSES the whitespace between a `v-if`
template and its next sibling, fusing „otvorené.Ako to funguje?"; the fix is an explicit
`{{ ' ' }}` node, and both branches are now whole-string pinned so a PO copy change is a
deliberate edit.

**Not mine, recorded so they are not lost:** the landing issues the guest-links fetch
twice (session + `GuestSubOrders`) plus pickup/payment settings on every `/` → fold into
PI-T7's one-fetch work; and logging out from the drawer with an unsaved cart discards it
silently, because `switchUser` is not a route leave and no spec rule covers it.

**The meta-lesson, and it is the third time this row has produced it:** every one of the
three majors was a claim I had already made correctly SOMEWHERE — in a report, in one spec
file, in one spec helper — and then failed to carry to every place it applied. Finding a
rule is the cheap half.

---

## PI-T4 — the CLOSED landing: a parametrised state modal, and a read-only catalogue (2026-09-20)

**What shipped.** `components/LandingStateModal.vue` (the parametrised `NeoModal`:
`title` / `intro` / `lead` are props because PI-T5 is its second consumer);
`FriendOrder.vue` gained a `readonly` prop (landing-only) that renders the SAME grid
inert — `.p2-ro` on the cards wrapper, disabled steppers, no stock bars, no cartbar, no
tabgroup, no status banners; `FriendPortalSession.vue` gained the whole `closed` branch
(`closedModalDismissed`, the modal, the `.banner.warn.slim` that replaces it, the
„Minulá ponuka · {name}" caption row, the read-only `catalogCycle` grid and the
„Ponuka ešte nie je pripravená." empty state); two helpers in `e2e/helpers/portal.js`;
nine new tests in `portal-landing.spec.js` §5; two sanctioned one-line edits.

### 1. ⚠⚠ THE DATE CONFLICT IS STILL A PO QUESTION, AND IT IS NOW PINNED AS A FACT

§1 of this file left PI-T4 the job of NOT resolving it, and the row did not. The closed
landing prints the same date twice, in two formats, and both are specified:

| surface | format | source |
|---|---|---|
| the modal's 38 px card | „3. 12." | `lib/dates.js fmtDayMonth` (18 §UC-PI-002) |
| the warn banner after dismissal | „…približne 3. decembra" | `cycle-stages.js nextOpeningText` (17 §UC-CS-005) |

What changed is that the state of play is now **measurable in both directions**, because
one test asserts each half AND the absence of the other (`portal-landing.spec.js` §5,
„the SHORT form in the card, the LONG form in the banner"). Two mutations prove it is not
decoration:

- **M2** — the card switched to 17's long form (the „obvious fix"): reds 2.
- **M3** — the banner re-formats 17's sentence with `fmtDayMonth` at the call site
  (the other „obvious fix"): reds 1.

So neither call-site resolution can ship quietly, and when the PO rules, exactly one of
those two expectations is the edit. ⚠ The test carries a non-vacuity line nobody would
think to write: `expect(short).not.toBe(long)` — if ICU ever collapsed the two spellings
the whole test would measure nothing, silently.

⚠ And the correction §UC-PI-002 already carries is worth repeating once more, because it
is what makes the conflict findable: the two forms are **not both inside the modal**. In
the `opens_at === null` branch the modal carries `nextText` alone and there is no
collision there at all. A reader who checked the older „both forms in one modal" wording
against the screen would have found it false and could have concluded the whole conflict
had evaporated.

### 2. ⚠⚠ MY „NO PERSISTENCE" TEST COULD NOT FAIL, AND THE MUTATION IS THE ONLY REASON I KNOW

„Once per SESSION, no persistence" was written as: dismiss, reload, the modal is back.
**M1 (store the dismissal in `localStorage`) left that test GREEN.** The cause is in the
spec file's own fixture, not in the app: `signIn()` seeds the session through
`page.addInitScript(() => { localStorage.clear(); … })`, and **an init script runs on
every navigation, a reload included** — so the reload wiped the persisted flag on its way
in and the modal came back for a reason that had nothing to do with the implementation.
The accompanying „nothing is in storage" dump assertion was vacuous for the same reason.

The fix is a local variant that seeds the session WITHOUT clearing. Re-measured, **M1
then reds two tests** — the reload one and the cross-friend one. ⚠ The general rule, and
it bites any spec in this suite that asserts something is NOT persisted: **`signIn()` is
storage-hostile; a test about storage may not use it.** The cross-session test was the
only thing standing between M1 and a green run, and it only works because it logs the
second friend in *in the same document*.

⚠ Second-order: the cross-friend walk had to use the **shared-password** card, not the
username one. `seed.mjs` leaves the gate DB in `auth_mode = 'legacy'` and
`FriendPortal.vue` renders the username form only in `modern`; flipping the mode for one
test is a global settings write every later file would inherit. Which credential opens
the session is irrelevant to the claim.

### 3. THE READ-ONLY GRID IS `FriendOrder` WITH FOUR SWITCHES, AND `.p2-ro` GOES ON THE CARDS

§UC-PI-006 says „never a second card template", and the prototype disagrees with the spec
about scope: `portal2.jsx:291` wraps the category strip AND the cards in `.p2-ro`, while
resolved conflict 6 says only the cards fade. The spec wins, and it is not cosmetic —
`.p2-ro` is `pointer-events:none`, so the prototype's placement makes every category past
the first unreachable.

⚠ **Proving that took TWO mutations, and the first one was not evidence.** M4 (move
`.p2-ro` to the panel) reddened the read-only test — but on the `toHaveClass` assertion,
which says nothing about interactivity. **M4b** puts `.p2-ro` on BOTH nodes, so the class
assertion stays green and the only thing left to fail is the category click: it fails,
with „`<div class=…>` intercepts pointer events". *A mutation that trips the first
assertion in a test has not exercised the rest of it.*

The other three switches are pinned 1:1 — M5 (stock bars), M6 (cartbar), M9 (tabgroup),
one test each. ⚠ M6 reddened only the new test and NOT PI-T3's „a round that is not OPEN
offers no share affordance": that test's closed fixture is a STUB cycle id with no row
behind it, so the embedded `FriendOrder` fails its load and renders no cartbar whatever
the `readonly` rule says. The claim survives on the drawer half; the cartbar half of it
is now carried by §5's read-only test, against a real round.

### 4. ⚠ A GUARD THAT IS DEFENCE IN DEPTH, AND A GATE THAT WAS DEAD CODE — BOTH SAID OUT LOUD

Two mutations reddened **nothing**, and both findings are kept in the source as comments
rather than quietly removed:

- **M12** — `editingLocked` drops its `isReadonly` term. Nothing reds, because
  `readonly` is only ever handed a `locked`/`completed` round today (`resolveLanding`
  guarantees it), so `isLocked` already refuses every edit. It stays: a future caller
  that renders an OPEN round read-only would otherwise get a live cart under a 55 %-opacity
  grid with no cartbar. Same shape as PI-T3 §2's M13 and PI-T2 §2's M2.
- **M10** — `showClosedModal` drops its `view === 'shop'` term. Nothing reds, and here the
  reason is that the term is genuinely redundant: the modal is MOUNTED inside the
  `view === 'shop' && state === 'closed'` template branch. ⚠ The realistic defect is
  hoisting the mount to session level, and **that** (M10′) reds — but only after a test
  was added that visits `/zostatok` **before** any dismissal. After the dismissal the flag
  hides the modal everywhere and the gate is unmeasurable, so the assertion's POSITION in
  the test is load-bearing.

### 5. THE CAPTION ROW IS THE CONSUMER'S, AND IT ASKS MODULE 17 RATHER THAN DECIDING

`CycleTimeline` renders six dots and nothing else (17 §UC-CS-006, and its own template
says so), so „Pauza · Objednávky · Doručenie" lives in `LandingStateModal.vue`. Which of
the three is emphasised comes from **`stageIndex()`** — 17's status-first translation —
never from a locally built step array, and the component is handed `:cycle`, never
`:steps`. Passing `:steps` would hand this module ownership of each step's `state`, which
is exactly the door the three measured stale-`stage` transitions (09 §10) come back
through, on one screen, with nothing going red.

Pinned through the `aria-label` („Krok 1 z 6: Pripravujeme ďalšiu objednávku"), which is
where 17's vocabulary shows in the DOM, plus computed `font-weight` on the three captions.
⚠ **Two fixtures, because one could not discriminate:** with a planned round the answer is
„Pauza" (step 1) and with nothing planned it falls back to `catalogCycle` and becomes
„Doručenie" (step 6). M7 (hardcode the first caption) and M8 (`catalogCycle` picked before
`nextCycle`) each red that one test.

### 6. Small things measured rather than assumed

- **A closed landing now opens a `role="dialog"` BY ITSELF, and its scrim covers the
  hamburger.** Two shipped tests land closed and then reach for the drawer
  (`portal-landing`'s „no share affordance" closed branch, `portal-menu`'s „1 objednávku"
  row); both take a one-line `dismissLandingState(page)`, which is the new helper's whole
  reason for existing. The enumeration was done with `grep -n "friends/cycles"` across
  `tests/` and then by reading every fixture's `status:` — six UI spec files stub the
  payload, and exactly two of them produce a `closed` landing followed by a click.
  `portal-appbar`'s two closed fixtures assert only `textContent`, which a scrim does not
  affect.
- **`dismissLandingState()` asserts the modal is there before dismissing it.** A helper
  that shrugged when it found nothing would let „the modal stopped opening" pass every
  caller that used it.
- **The read-only grid needs a REAL round**, so the test creates one, adds two purposes'
  products, PATCHes it to `completed`, and then stubs `GET /friends/cycles` to contain
  nothing but that row — the gate DB carries ~135 open rounds, and completing one does not
  make the landing closed.
- **The „no stock bars" absence is gated by the deep link.** The same product on
  `/cycle/:id` (via `gotoCycle()`) still renders its bar, which is simultaneously the
  non-vacuity gate and the proof that `readonly` is landing-only and §UC-PI-018's screen is
  untouched.
- **`panel-own` stops being a `tabpanel` in `readonly`**: the tabgroup is gone, so
  `role="tabpanel"` + `aria-labelledby="tab-own"` would point at an element that does not
  exist. Vue drops a `null` attribute entirely, so the other two mounts keep their markup
  byte for byte.
- **The `+14 days` fixture is chosen, not arbitrary**: `Math.round(14 / 7) === 2` whatever
  „today" is, and 2 takes the 2–4 declension („o 2 týždne"), so the exact weeks string is
  assertable without drifting with the calendar.
- The banner's `white-space:pre-line` (branch 2 of `nextText` is the admin's `plan_note`,
  verbatim) forced the whole bold-plus-interpolation to sit on ONE source line: template
  indentation would otherwise become rendered whitespace.

### 7. The mutation matrix, in full (all reverted from a scratchpad copy, never `git checkout`)

| # | Mutation | Reds |
|---|---|---|
| M1 | the dismissal persisted in `localStorage` | **0 at first** (§2); 2 after the fixture was fixed |
| M2 | the modal's card formats with 17's `fmtDay` | 2 — the modal test and the collision test |
| M3 | the banner re-formats 17's sentence with `fmtDayMonth` | 1 — the collision test |
| M4 | `.p2-ro` moved to the panel | 1, but on the CLASS assertion — not evidence (§3) |
| M4b | `.p2-ro` on the panel AND the cards | 1 — the category click, „intercepts pointer events" |
| M5 | stock bars not hidden in `readonly` | 1 — the read-only test |
| M6 | the cartbar renders in `readonly` | 1 — the read-only test (§3 on why not 2) |
| M7 | the active caption hardcoded to the first word | 1 — the dots test |
| M8 | the timeline reads `catalogCycle` before `nextCycle` | 1 — the dots test |
| M9 | the tabgroup renders in `readonly` | 1 — the read-only test |
| M10 | `showClosedModal` drops its `view` term | **0** — dead code (§4) |
| M10′ | the modal hoisted OUT of the `shop` branch | 1 — the view-gate assertion (§4) |
| M11 | `catalogCycle` falls back to `nextCycle` | 1 — the empty-state test |
| M12 | `editingLocked` drops its `isReadonly` term | **0** — defence in depth (§4) |

### What PI-T4 LEAVES BEHIND

1. **`LandingStateModal.vue` is PI-T5's, ready.** The no-order LOCKED variant passes
   `title="Objednávky sú ~~uzamknuté~~ uzavreté"` (GP-T7) and the §UC-PI-007 intro and changes nothing else;
   a second modal component is the defect this parametrisation exists to prevent.
2. **`FriendOrder`'s `readonly` is PI-T5's too** — but §UC-PI-007 keeps the TABGROUP on the
   locked landing („Kolegovia hand-over ticks happen precisely now"), so that row needs a
   third switch rather than a reuse of this one. The `v-if="!isReadonly"` on the tabgroup
   is the line it will have to split.
3. **Landing slot 3 (the debt banner) is still empty in the closed branch too** — PI-T7's,
   and marked in the template where it goes.
4. ⚠ **PI-T12 owes `portal-fidelity` the A10 pins for the new surfaces** (`.banner.slim`
   on the closed banner, `.field-lbl` in the caption row, the 38 px `.display` in the
   modal's card) and a 320 px hostile-text pass over the closed state. **✔ DISCHARGED by
   PI-T12 §1–2 — and the 320 px pass found the modal's own footer overflowing.**
5. ⚠ **`portal-vocabulary.spec.js` (PI-T11) must add `components/LandingStateModal.vue` to
   §UC-PI-017's grep list** — it is a friend surface with Slovak copy and it is in no file
   list today.

---

## PI-T5 — the LOCKED landing: the own-order card, the vertical timeline, and one split term (2026-09-20)

**What shipped.** `lib/order-lines.js` (the hoisted `CartLineList` normaliser:
`lineSize` / `cartLines` / `orderLines` / `deliveryExtras`); `FriendOrder.vue` gained a
`colleaguesTab` prop + a `hasTabs` computed (the tabgroup term, split off `isReadonly`),
a kept `orderItems` ref with `submittedLines` / `submittedItemsTotal`, an `orderPickup`
ref + `orderPickupText`, an `ownOrder` projection and `openPaymentModal`, both exposed;
`routes/orders.js`'s friend order GET publishes `p.purpose` on its items and a top-level
`pickup` block from `helpers/pickup.js pickupOf()`; `NeoIcon` gained `pin`;
`FriendPortalSession.vue` gained the whole `locked` branch (own-order card, „Kde je vaša
káva“, the next-round banner, the no-order `LandingStateModal` variant, the shared
caption + read-only grid) and renamed PI-T4's dismissal flag to `stateModalDismissed`;
twelve new tests in `portal-landing.spec.js` §6/§6b; three sanctioned one-line edits.

### 1. ⚠⚠ THE SEAM PI-T4 NAMED WAS A TERM WITH TWO QUESTIONS IN IT, AND SPLITTING IT IS THE ROW

PI-T4 gated four template sites on `isReadonly` and wrote down that PI-T5 would have to
split them, because §UC-PI-006 says the closed catalogue has **no tabgroup** and
§UC-PI-007 says the locked landing **keeps** it. The two flags now ask different
questions, and the names say which:

| flag | question | consumers |
|---|---|---|
| `isReadonly` | „may any quantity on this screen change?" | `.p2-ro`, disabled steppers, no stock bars, no cartbar, no status banners |
| `hasTabs` | „may this friend still reach the Kolegovia panel?" | the `.tabgroup`, `#panel-guests`'s `v-if`, and `#panel-own`'s `v-show` / `role` / `aria-labelledby` |

⚠ **It had to be a PROP and not a derivation, and that is the whole finding.** Both
landings hand the component a `locked`/`completed` round with `readonly: true` — there is
nothing inside `FriendOrder` that tells the two apart. The difference is *which landing is
mounting it*, and only the caller knows that. `colleaguesTab` can only ever ADD the tabs
back to a read-only mount (`hasTabs = !isReadonly || colleaguesTab`), so no value of it can
take them off the deep link or the open landing.

⚠ **Proved in BOTH directions on one page object**, which is what makes it more than a
restatement: `portal-landing.spec.js` §6's tabgroup test asserts the tabs on the locked
round, then PATCHes that very cycle to `completed`, re-stubs and asserts they are gone —
with the `.p2-ro` grid still there either side, so what changed is the tabgroup and
nothing else. **M1** (collapse to `!isReadonly`) reds 2; **M2** (collapse to `true`) reds 2,
one of them PI-T4's. A single flag cannot satisfy both columns, whichever way it is
collapsed.

### 2. ⚠⚠ PI-T4'S FIX MADE THE CARD NECESSARY, AND IT ALSO BROKE THE MONEY UNTIL IT WAS BRANCHED

`readonly` clears the cart (`if (isReadonly.value) cart.value = {}`, PI-T4's review fix),
and on a LOCKED landing the friend almost always HAS an order — this is the screen that
fix was written for. But every money figure in the file was derived from the cart:

```
paymentTotal = cartTotal + delivery_fee    // cartTotal is 0 in readonly
```

so the card, the „Zaplatiť“ button and `PaymentModal` would all have billed the delivery
fee alone. The fix is NOT a second total: `payableItemsTotal` picks the source
(`isReadonly ? submittedItemsTotal : cartTotal`) and `paymentTotal` stays the ONE computed
every payment surface on the screen reads. **M3** (drop the branch) reds 3.

⚠ The lines have the same shape of problem and the same shape of answer: the server's
`items` used to be consumed into `cart` and discarded, so an `orderItems` ref now KEEPS
them. That is also what makes the card's prices the SNAPSHOT ones — a price the admin
edited after the round locked must not rewrite what the friend is told they ordered.
**M4** (`orderItems = []`) reds 3.

⚠ **What the row does NOT do, said out loud because this is the most dangerous money
surface in the module:** it writes no `transactions` row of any kind. `paid` renders
read-only (admin-only write), `paymentTotal` includes `delivery_fee` for DISPLAY only, and
the variable symbol is quoted from the server (`payment.variable_symbol`, a friend order's
VS *is* its order id). The „no ledger row" claim is an assertion, not a comment: §6 reads
the friend's own `/api/transactions/friend/:id` before and after opening the payment
modal. **M15** (`paid: false` hardcoded) reds the admin-marks-paid test alone.

### 3. THE OWN-ORDER CARD IS IN THE SESSION, ITS DATA AND ITS MODAL ARE IN `FriendOrder`

§UC-PI-007's composition forces the split: the card, the timeline and the next-round
banner sit ABOVE the grid in the page column, so they are the session's; but „renders from
FriendOrder's loaded `order` (no second loader)" and „one `PaymentModal`" make the data and
the mount the component's. So the bridge is `defineExpose`, exactly as PI-T3's
`openShareDialog` / `cartTotal`: the session reads `ownOrder` (a computed, unwrapped by
`proxyRefs`, so it stays reactive) and calls `openPaymentModal()`. It holds no copy of
anything and fires no GET of its own — pinned in source, because a second `PaymentModal`
is invisible in the DOM until the two disagree about an amount.

⚠ `lockedOrder` is a SEPARATE template ref from `landingOrder`, not a reuse. PI-T3's two
readers of `landingOrder` mean „the OPEN round's live surface": `landingCartTotal` feeds
drawer item 1's „ · v košíku …" and `requestShareDialog()` treats the instance's existence
as „there is a round to share". A read-only mount has an empty cart and nothing to share,
so pointing that ref at one would answer both questions with a mount that cannot mean them.

### 4. ⚠ THE PICKUP BADGE NEEDED A BACKEND FIELD, AND THE ACTIVE-ONLY LIST WAS THE TRAP

The card shows exactly one of a location NAME, a free-text note or „Packeta · {address}".
The name is the only one the order row does not carry. The obvious client-side source —
`FriendOrder`'s `pickupLocations`, already loaded — is the PUBLIC picker feed, i.e.
`active = 1` only, so a point deactivated after this order chose it would leave the badge
blank on a party whose pickup is perfectly well defined. `helpers/pickup.js pickupOf()`
already solves exactly that (its no-`active` lookup carries a comment saying so), so the
route publishes its shape as a **top-level `pickup`**, never spliced into the `SELECT *`
order row — the same rule `payment` states one function above it.

⚠ It is `pickupOf(order)` and NOT `readPickup(cycleId, friendId)`: that one re-resolves
WHICH STORE a party's pickup lives in, and this route already holds the `orders` row, which
is the store that wins whenever it exists. ⚠ And no new SELECT: FUP-T25's grep guard
(`"pickup_locations WHERE id = ? AND active = 1"` returns ONE hit) is untouched, because
this path adds no statement at all.

⚠ The test earns its fixture: the `location` variant CREATES a pickup point, submits
against it and then DEACTIVATES it before the page ever loads — which is simultaneously
the „soft-deleted point still has a name" pin and the housekeeping that keeps
`pickup_locations` (a GLOBAL table) free of leftovers for the distribution specs.
**M6** (`pickup: null`) and **M7** (the Packeta branch dropped) each red the pickup test.

### 5. `p.purpose` WAS MISSING FROM THE ORDER GET, AND `CartLineList` FAILS QUIETLY WITHOUT IT

`CartLineList` groups by purpose with a badge header per group and falls back to
`'Ostatné'`. The friend order GET selected `oi.*` plus four product columns — and not
`purpose` — so every line of the card landed under one wrong header. It is a one-word
additive SELECT change, and the client cannot paper over it: **PI-T6's history view renders
the lines of rounds whose catalogue it never loads**, so there is no `products` array to
look the purpose up in. **M5** reds the card test alone.

### 6. `lib/order-lines.js` — the hoist, and why it is a lib rather than a second computed

The mapping into `CartLineList`'s shape (and `lineSize`'s `variant_label` / `'ks'` /
raw-key ladder) lived inside `FriendOrder.vue` because that view was the only screen with
an ordered list of its own. It now has two consumers that are not that view and never will
be: this card (which cannot read `cartItems` — the cart is empty by design) and PI-T6's
history. The file is dependency-free for the `cycle-stages.js` reason: with no unit runner,
a plain `node` import from a spec IS the unit test.

⚠ Two mappers, not one with a clever `??`: `cartLines` quotes the cart's already-marked-up
`total`, `orderLines` computes `price × quantity` from the server's SNAPSHOT price. They
answer different questions about money and collapsing them would hide that. **M13**
(`deliveryExtras` returns `[]`) reds the card test.

### 7. ⚠ THE DATE IN THE NEXT-ROUND BANNER IS SHORT — AND THAT IS *NOT* THE PO QUESTION

§1 and PI-T4 §1 of this file forbid resolving the two-format collision at a call site, and
this row does not. The collision is about ONE sentence, module 17's „Ďalšia objednávka sa
otvorí približne {fmtDay}". §UC-PI-007's banner is a DIFFERENT sentence — „Ďalšia
objednávka približne {date} — ponuku si už môžete prezrieť nižšie." — which
`nextOpeningText()` cannot produce and does not own. PI-T1's rule decides it without a new
judgement: a date standing alone after a preposition is SHORT (`lib/dates.js`); only a date
inside one of 17's composed sentences is LONG. The locked-no-order warn banner still prints
`landing.nextText` verbatim, long form and all, exactly like the closed one.

**M10** (the banner prints 17's long form) reds the banner test, which also carries the
`expect(short).not.toBe(long)` non-vacuity line PI-T4 introduced.

### 8. ⚠ THE FIRST `variant="vertical"` TIMELINE, AND THE ASSERTION THAT WOULD HAVE BEEN WORTHLESS

Module 17 recorded that a computed-style read of `.mk`'s border proves nothing inside
`.app`: the portal supplies `--nb-ink` with a value byte-identical to the component's own
fallback, so the assertion passes whether the fallback exists or not (the real proof lives
on the admin page, where the token is absent). So §6 pins the **step counts** (6 steps,
2 done / 1 now / 3 next on a freshly locked round — CS-T1: lock ⇒ `ordered`) and the
**current step's label**, and then ADVANCES the stage through the admin route so the „now"
step MOVES. That last half is what a hardcoded render fails: **M12b** (the component handed
a frozen `{status:'locked', stage:'ordered'}` object) passes every count assertion and reds
on the move. **M12** (`variant="compact"`) reds the same test.

⚠ `:cycle`, never `:steps`, and no `order` prop at all — 17 §UC-CS-006 says „No other
props", and Vue would turn an undeclared one into a fallthrough ATTRIBUTE on the root div
(`order="[object Object]"`). §UC-PI-007 is amended in place to say so.

### 9. ⚠ A TERM THAT REDS NOTHING, AND THE MUTATION THAT SHOWS WHY IT STAYS — PI-T4 §4 AGAIN

`showLockedModal` carries `&& !currentCycle?.hasOrder`. **M8** (drop it) reds **nothing**,
because the modal is MOUNTED inside the `v-else` of the `hasOrder` branch — the template is
what enforces it today. The realistic defect is a later row moving that mount, and **M8′**
(the mount reaches the own-order branch too, term dropped) reds **3**: the scrim covers the
tabgroup click and the timeline read. Same shape as PI-T4's M10/M10′ and PI-T3's M13 — kept,
and said out loud in the source rather than quietly deleted.

### 10. ONE DISMISSAL FLAG FOR BOTH STATES, deliberately

`closedModalDismissed` became `stateModalDismissed`. `LandingStateModal` is ONE
parametrised component (that is why PI-T4 built it), and the flag answers „has this friend
already been told why there is nothing to order in this session?". A landing is closed or
locked, never both; two flags would differ only if an admin changed a round's status
mid-session, and the honest answer there is still „they have been told". Everything PI-T4
wrote about WHERE the flag lives (a `ref` in the session, never storage, never a plain
`<script>` block, never the parent) is unchanged and is the reason it is not two.

### 11. The sanctioned e2e edits — and the sweep that found them

A locked landing with **no own order** now opens a `role="dialog"` by itself, whose scrim
covers the hamburger. That is PI-T4 §6's finding with `closed` replaced by `locked`, and it
broke three shipped tests whose stub payloads are `hasOrder: false` by default. All three
take the one-line `dismissLandingState(page)`:

- `portal-landing.spec.js:526` — its `if (state === 'closed')` condition is now GONE, not
  inverted; PI-T4's note („the LOCKED half has no modal until PI-T5") expired with this row.
- `portal-menu.spec.js` ×2 (the row-set test, item 1's sub-line).

⚠ The enumeration was `grep -ln "friends/cycles" tests/` then reading every fixture's
`status:`. **Three UI files stub a locked landing and then click**; `portal-menu`'s third
locked fixture (`:575`) needed NO edit because it lands on a non-`shop` view, where the
modal is not mounted at all — which is PI-T4's M10 observation showing up as a passing test.
`portal-appbar`'s three locked fixtures assert `textContent` only, which a scrim does not
affect.

⚠ A second consequence of the same stubs, recorded because it looks like a bug and is not:
`portal-appbar`'s `hasOrder: true` fixtures point at STUB cycle ids with no row behind them,
so the embedded `FriendOrder` fails its load and the own-order card never appears (its
`v-if` waits on `lockedOwnOrder`). Those tests measure the appbar, they still pass, and the
320 px overflow one now exercises the vertical timeline as a bonus.

### 12. Mutation matrix (all reverted from a scratchpad copy, never `git checkout`)

| # | Mutation | Reds |
|---|---|---|
| M1 | `hasTabs` collapsed to `!isReadonly` | 2 — the tabgroup test and the no-order one |
| M2 | `hasTabs` collapsed to `true` | 2 — the tabgroup test and PI-T4's read-only catalogue |
| M3 | `paymentTotal` always sums the CART | 3 — card, PaymentModal, paid |
| M4 | `orderItems` thrown away again | 3 — the same three |
| M5 | `p.purpose` dropped from the items SELECT | 1 — the card's group headers |
| M6 | the server publishes `pickup: null` | 1 — the pickup test |
| M7 | the pickup row's Packeta branch deleted | 1 — the pickup test |
| M8 | `showLockedModal` drops its `hasOrder` term | **0** — the template branch enforces it (§9) |
| M8′ | …with the mount reaching the own-order branch | 3 — scrim over the tabs and the timeline |
| M9 | the locked modal's dots read `nextCycle ?? catalogCycle` | 1 — the no-order test's caption |
| M10 | the next-round banner prints 17's long date | 1 — the banner test |
| M12 | the timeline mounts `variant="compact"` | 1 — the timeline test |
| M12b | the timeline handed a FROZEN cycle object | 1 — only on the „now moves" half (§8) |
| M13 | `deliveryExtras` returns `[]` | 1 — the card's fee assertions |
| M15 | `ownOrder.paid` hardcoded `false` | 1 — the admin-marks-paid test |

### What PI-T5 LEAVES BEHIND

1. **`lib/order-lines.js` is PI-T6's, ready.** „Moje objednávky" maps its lazily fetched
   rounds with `orderLines()` + `deliveryExtras()` and feeds `CartLineList` — no second
   normaliser, and the `p.purpose` column it needs is already on the payload.
2. **The debt-banner slot (§UC-PI-008) is marked in the LOCKED branch too** — PI-T7's, „above
   the own-order card". All three landing states now carry the same empty comment.
3. **`FriendOrder`'s `ownOrder` / `openPaymentModal` are a published seam.** PI-T7 must not
   mount a second `PaymentModal` for the ORDER; the balance one is `FriendBalanceCard`'s and
   is RELOCATED, never duplicated.
4. ⚠ **PI-T11 must add nothing new to §UC-PI-017's grep list from this row** — the locked
   landing's Slovak lives in `FriendPortalSession.vue` and `LandingStateModal.vue`, both
   already named (the latter by PI-T4's handoff).
5. ⚠ **PI-T12 owes `portal-fidelity` the A10 pins for `own-order-card .display` and
   `.cs-tl .lbl`** (**✔ DISCHARGED by PI-T12 §1 — pinned at the CANON's values, which are
   not `normal`; the `.display` was shipped at `.9` against the canon's `1` and is fixed**)
   — §UC-PI-019 item 13 already lists both; this row shipped the surfaces
   they describe, at 320 px included (`portal-appbar`'s overflow test now covers the
   timeline incidentally, which is not the same as a hostile-text pass).
6. ⚠ **`.p2-lines` in `friends-theme.css` (A13) is still unconsumed and should stay that
   way.** The A13 note names PI-T5 as its consumer; the one-home rule outranks it —
   §UC-PI-007 says „lines via `CartLineList`", and that component brings its own styles.
   PI-T6 will not need it either.

## PI-T6 — „Moje objednávky": a second status vocabulary, on purpose (2026-09-20)

**Row:** `18 §UC-PI-009` — the history view. Rounds the friend ordered in, newest first,
each a card with a SHORT status badge and a lazily fetched line list; an empty state;
read-only. New `frontend/src/lib/history-badges.js`, a `view === 'history'` block in
`FriendPortalSession.vue`, new `e2e/tests/portal-history.spec.js` (15 tests), one
sanctioned retarget in `portal-landing.spec.js`.

### 1. ⚠⚠ THE DUPLICATION THAT LOOKS LIKE A DEFECT AND IS THE POINT

The six badges — **Odoslaná · V pražiarni · Balíme · Zabalená · Odovzdaná ·
Vyzdvihnuté** — are a SECOND status vocabulary beside module 17's
`lib/cycle-stages.js STEPS` („Objednávky uzavreté, káva objednaná v pražiarni",
„Zabalené, rozvážame", „Objednávka ukončená"). §UC-PI-009 says so in its own table
(„⚠ These are the SHORT history forms owned here; the timeline's long labels are module
17's") and this repo has spent the week collapsing duplicated strings into single homes,
so the next reader's instinct will be to „fix" it by importing `STEPS`.

The argument, written at the definition rather than left to be re-derived: these are not
ONE fact rendered twice (a price, a variable symbol, a kg label — the things the one-home
rule is actually about). They are two registers for two surfaces. 17's labels are read one
at a time on a screen whose whole job is to explain where the coffee is; these sit in a
`span.badge` beside a 20px round name and a total, in a list the friend scans. Import
`STEPS` and every badge grows a comma and a subordinate clause, wrapping to three lines at
320 px; shorten `STEPS` instead and the timeline stops being a sentence.

⚠ WHAT IS SHARED AND STAYS SHARED: the DATA (`status`/`stage` from 17, `orderHandedOver`
from 16 via PI-T1's payload) and the STATUS-BEFORE-STAGE reading order — CS-T1's three
measured stale-`stage` transitions are invisible here for exactly 17's reason, and
`portal-history.spec.js` §1 pins both directions with `{ status: 'open', stage: 'ready' }`.

⚠ The split is a MEASUREMENT, not a promise: §1 imports both libs with plain `node` and
asserts no short form is one of 17's six, that 17's really are the comma-carrying ones,
and that the longest short form is shorter than the shortest long one — with a
non-vacuity gate on both harvests. **M7** (one badge replaced by the exact `STEPS` label
an import would give it) reds **4**. A source pin also holds `history-badges.js` free of
`cycle-stages`/`STEPS` in its EXECUTED code (the header discusses both at length).

### 2. THE PER-ROW GUARDS — AND WHICH HALF ACTUALLY REDS ANYTHING

§UC-PI-009 asks for „per-row pending + a per-row `rowSeq`", one round expanded at a time,
and a cache per round for the session. Implemented as: `expandedRound` (a scalar — the
rule IS the data structure), `roundLines`/`roundPending`/`roundError` keyed by cycle id,
and a plain `Map` of sequence counters (not a `ref`: nothing renders from it).

Measured, each mutation reverted from a scratchpad copy:

| # | Mutation | Reds |
|---|---|---|
| M1 | `historyBadge` drops its `orderHandedOver` term | 2 — §1's matrix, §2's badge list |
| M2 | the list drops the `hasOrder` filter | 3 — the filter test, the drawer-agreement test, the empty state |
| M3 | the line cache is never consulted (every expand refetches) | 1 — „then exactly once" |
| M4 | ONE shared pending flag, keyed cache intact | 1 — §4's cached-round test |
| M5 | every `roundSeq` check deleted | **0** — see below |
| M5′ | ONE shared `lines`/`pending` pair (the pre-guard shape) | 3 — §3's one-at-a-time, both of §4 |
| M7 | a badge carries 17's long label | 4 — §1 ×3, §2's badge list |
| M8 | a SECOND `getOrderByFriend` in the session | 1 — the retargeted PI-T5 source pin |

⚠ **M5 = 0 is the honest part.** The keyed cache and „no second fetch while one is
pending" already make a stale write unreachable, so the sequence counter is defence in
depth today — the PI-T5 §9 `showLockedModal` shape. It is KEPT, and both the source and
the spec say it reds nothing rather than implying a test that does not exist; the
realistic future defect it guards (the cache collapsing back to one ref) is M5′.

### 3. ⚠⚠ A RETRYING ASSERTION HEALS OVER THE DEFECT IT MEASURES — M4 PASSED AT FIRST

The first version of §4 held one round's response with a `page.route` timer of **5 s**,
per CLAUDE.md's „≥4 s" rule, and then asserted that the OTHER (cached) round paints its
own lines. **M4 passed all 15 tests.** The hold satisfies CLAUDE.md and is still useless
here: `expect` RETRIES for `expect.timeout`, which this repo sets to **10 s**, so the
assertion simply waited for the held response, watched the shared pending flag clear and
reported green. The rule CLAUDE.md states is necessary and not sufficient — **the hold
must outlast the assertion window, or the assertion must be made impatient**. Fixed by an
8 s hold plus an explicit `{ timeout: 3_000 }` on the two discriminating assertions; M4
then reds 1. The same trap explains why the count-only version of §3's one-at-a-time test
was worthless: a single shared cache renders two lines under the wrong round, so that
test now asserts the lines' CONTENT (which is what makes M5′ red 3 instead of 2).

### 4. THE PI-T5 SOURCE PIN THAT §UC-PI-009 MADE UNSATISFIABLE

`portal-landing.spec.js:1547` asserted `FriendPortalSession.vue` contains no
`getOrderByFriend` at all („no second order GET in the session view" — PI-T5's rule that
the locked own-order card reads the embedded `FriendOrder`'s loaded order). §UC-PI-009
names that exact function as the history view's lazy loader, in this same component, so
the absence could not survive. Retargeted under case (a): the count is pinned at **1**
and that one call must sit inside `loadRoundLines`, while the `lockedOrder.value?.ownOrder`
line stays. **M8** (a second loader added beside it) reds it, so the retarget is not a
weakening — a second loader still fails exactly as before.

### 5. Smaller things worth not re-deriving

- **`lib/order-lines.js` was ready and needed nothing.** `orderLines()` +
  `deliveryExtras()` map the server rows; `CartLineList` renders them. **No
  `purposeOrder` is passed and that is deliberate** — this view never loads a round's
  catalogue, so there is no category strip to align the groups with, and the component's
  documented first-appearance fallback is the only available answer. PI-T5's additive
  `p.purpose` on the order GET is what makes the group headers right at all.
- **`.p2-lines` stays unconsumed** (PI-T5 §6 handoff): `CartLineList` brings its own
  styles and is the one home.
- The card is `role="button" tabindex="0"` with Enter/Space and `aria-expanded` — the
  `.p2-mi` idiom; the prototype's whole-card click would otherwise be mouse-only.
- A stub of only COMPLETED rounds makes the LANDING `closed`, so a drawer test that
  starts on `/` needs `dismissLandingState` (learnings §11). Starting on
  `/moje-objednavky` avoids it entirely — non-`shop` views never mount the modal.
- `roundSeq` is a plain `Map`, session-scoped by being a `const` inside `<script setup>`
  (per INSTANCE, dying with the session) — the `guestCountSeq`/`inviteSeq` precedent.
  Nothing in this row touches `localStorage`, a plain `<script>` block or the parent.

### What PI-T6 LEAVES BEHIND

1. **`lib/history-badges.js` is a one-home file with a vocabulary argument in its header.**
   A future row that wants the words changed changes them there; a future row that wants
   them merged with 17's has to delete §1 of `portal-history.spec.js` to do it.
2. **PI-T7 owns the landing slot and the balance view; nothing here reads `balance`.**
   The history tests stub `GET /friends/*/balance` only to keep the fixture quiet.
3. ⚠ **PI-T11's vocabulary sweep gains no new file from this row** — the history view's
   Slovak lives in `FriendPortalSession.vue` (already on the list) and in
   `lib/history-badges.js`, whose six words contain no „kolo"/„cyklus". Its DOM sweep
   should nonetheless visit `/moje-objednavky` with a round expanded.
4. ⚠ **PI-T12's `portal-fidelity` A10 list should gain `history-round .display`** — the
   20px round name and the 18px total both carry inline `line-height`, for the reason
   every `.display` on this surface does. **✔ DISCHARGED by PI-T12 §1 — and ~~for the
   reason every `.display` does~~ the TOTAL's inline `.9` had no canon behind it
   (`portal2.jsx:211` sets only `fontSize: 18`), so it was removed and the total is A10.**

---

## PI-T7 — the money surfaces: the debt banner, „Zostatok a platby", and a relocation that had to happen in a third file

18 §UC-PI-008, §UC-PI-010, §UC-PI-019 items 7 and 9. Branch `task/pi-t7`.

### 1. RELOCATE, NEVER DUPLICATE — and the relocation target was neither of the two obvious files

PL-T4 made `FriendBalanceCard.vue` the one home of three things at once: the balance
FETCH, the „Zaplatiť" TRIGGER and the `PaymentModal` MOUNT. Module 18 gives that one debt
**two surfaces on two different VIEWS** — the landing's debt banner (§UC-PI-008) and the
account card on `/zostatok` (§UC-PI-010) — and that is what breaks the three apart:

- a mount that lives in the card **cannot be opened from a banner on another view**, and
  the second mount that would fix that is precisely the defect the rule forbids;
- so the mount went UP into `FriendPortalSession.vue`, together with the fetch, and both
  surfaces open it through one `openBalancePayment()`.

⚠ **„Relocated" therefore does NOT mean „moved into the balance view".** Reading it that
way is what produces two mounts, one per surface, each with its own copy of
`balancePaymentBlock()`'s answer. The end state is:

| thing | home | count |
|---|---|---|
| `api.getFriendBalance()` on the friend surface | `FriendPortalSession.vue` | 1 |
| balance `<PaymentModal>` mount | `FriendPortalSession.vue` | 1 |
| `data-testid="pay-balance"` | `FriendBalanceCard.vue` | 1 |
| `debt-banner-pay` | `DebtBanner.vue` (3 call sites) | 1 |
| `balance < -0.01` | `DebtBanner.vue` | 1 |

⚠ **The banner's button deliberately does NOT carry `pay-balance`.** Two elements
answering to one testid would make every `getByTestId('pay-balance')` in the suite
ambiguous the day both surfaces ever render together — and „they never do" is a property
of today's routing, not of the testid. Different control, same single modal.

### 2. The count PI-T2 left, and why an exact bound was the right instrument

`payment-links.spec.js` asserted `afterLoad === 2` with the comment „exactly two readers
on load: the card (03) and the session (18)". PI-T2 shipped the second reader knowingly
and tightened `<= 2` to `toBe(2)` so that this row could not collapse the readers while
the sentence naming two of them silently went false. It worked exactly as designed: the
pin reddened on the first run of this row and forced a deliberate rewrite.

⚠ **The rewrite is not „change 2 to 1".** The landing and the VIEW answer different
questions and the number had to be split between two files:
- §UC-PI-004 „one request per session load" is about the LANDING (the drawer badge must
  not cost a request per menu open) ⇒ `payment-links.spec.js` now pins **1** there;
- §UC-PI-010 „the view reloads balance + transactions on mount (a payment marked by the
  admin shows after re-entering the view — no polling)" is about `/zostatok`
  ⇒ `portal-balance.spec.js` §4 pins the reload, and entering the view makes it 2.

Measuring both in one number would have folded two rules into one assertion. Implemented
as `watch(view, …)` firing only on `shop → balance`; a COLD load at `/zostatok` never
changes `view`, so it reads once, from the session mount.

### 3. The migration mapping (produced BEFORE anything was deleted)

`portal-transactions-modal.spec.js` (11) → `portal-balance.spec.js`, plus
`portal-appbar.spec.js`'s „Balance card" describe (7). **18 out, 23 in the new file.**

| from | verdict |
|---|---|
| modal: opens/teleports onto `.modal-layer` | **RETARGETED** → „renders IN PAGE, with no dialog parked" (the inverse question, and the one that matters: a `.modal-scrim` is `pointer-events:auto`) |
| modal: × closes/unmounts, one „Zavrieť" | **DROPPED (unsatisfiable)** — the shell is gone. Its PROPERTY („a dialog here must UNMOUNT or its scrim eats clicks") is carried onto the one dialog the view still has, the balance `PaymentModal` |
| rows: one row per tx; sign/colour | **KEPT** (scope: dialog → page) |
| modal: the three money states in `.m-head` | **RETARGETED** to the card's `balance-amount`; the modal's duplicate `balanceState` derivation died with it |
| empty / error / loading | **KEPT** (error is now SCOPED — the card renders its own `.banner.danger.slim` on a balance failure and an unscoped locator would let it satisfy the ledger's assertion) |
| 320 px unbreakable name | **KEPT, outer measurement moved** — see §5 |
| admin invariance ×2 | **KEPT verbatim** |
| appbar: negative / zero / positive | **RETARGETED** — `.neg.pill` 16px → one `.display` 38px (canon) |
| appbar: „Transakcie" opens the modal | **DROPPED (unsatisfiable)** — §UC-PI-010 removes the button, PI-T7 deletes the component |
| appbar: failed load / loading / no BalanceBadge | **KEPT** on `/zostatok` |

**The accounting, and it adds up exactly.** 18 tests came in: **11 KEPT** (rows ×2,
empty, error, ledger loading, 320 px, admin ×2, failed balance load, card loading, no
BalanceBadge), **5 RETARGETED** (in-page instead of teleported; the `.m-head`
money states → the card's `balance-amount`; negative / zero / positive), **2 DROPPED as
unsatisfiable** (the × / „Zavrieť" shell test, „Transakcie" opens the modal). ⚠ An
earlier version of THIS sentence listed the × / „Zavrieť" test as BOTH retargeted and
dropped, and omitted the `.m-head` states — the TABLE above was right and the summary was
not (review, 2026-09-20). The dropped test's PROPERTY (a dialog here unmounts) survives on
`PaymentModal` (`portal-balance.spec.js:260-279`), which is what made the double-listing
easy to write and easy to miss: a property carried forward is not the same as the test
being retargeted. Plus **7
NEW**: the drawer entry point, the „Zaplatiť {suma}" shape, the no-block case, the
re-entry reload, and three source pins. 11 + 5 + 7 = **23**, and 16 + 2 = 18.

Across every touched file: `portal-transactions-modal` 11 → 0 (renamed),
`portal-balance` 0 → 23, `portal-appbar` 21 → 14, `portal-landing` 37 → 43 (+6, §8),
`payment-links` 67 → 67 (5 retargeted in place + the exact-count rewrite),
`portal-fidelity` 9 → 9 (one assertion retired, one re-pointed). **145 → 156, net +11.**

### 4. Every kept assertion was proved to still fail — six mutations

| mutation | reds |
|---|---|
| `n < -0.01` → `n <= 0` in `DebtBanner` | landing „zero and positive" + the source threshold pin |
| a second `<PaymentModal>` mounted in the card | `portal-balance` §6 ONLY — **invisible in every DOM test**, which is the whole argument for a source pin |
| „Nedoplatok — po zaplatení…" shortened | `portal-balance` §2 + `payment-links` |
| the card's own `getFriendBalance()` restored | `payment-links` exact-count + `portal-balance` §4 + §6 |
| the LOCKED `<DebtBanner>` call site removed | landing „LOCKED state: above the own-order card" |
| `overflow-wrap:anywhere` deleted from a ledger row | `portal-balance` §5 (320 px) |

⚠ Each mutation was **rebuilt into `backend/public` and the mutation verified present in
the source** before running — a mutation that never reached the served bundle proves the
opposite of what it looks like.

### 5. Things this row measured that are easy to get wrong

- ⚠ **`.neg.pill` and `.zero` now have NO renderer in `frontend/src`.** The card paints
  one `.display` at 38px (canon `portal2.jsx:232`), and `.neg`/`.display` cannot be
  combined: `friends-theme.css:216` declares `.neg{font-family:var(--font-mono);
  font-size:13px}` AFTER `:25`'s `.display` at equal specificity, so `.display.neg` paints
  the display face away. `portal-fidelity.spec.js`'s A10 pin was re-pointed at the
  surviving `.neg` (a ledger amount on `/zostatok`); its `near(…, CANON.negPill)` HEIGHT
  measurement is retired, ~~with `CANON.negPill` kept as the record~~ **and the constant
  itself was retired by PI-T12 §1 (nothing read it; the record is `friends-theme.css` §A10's
  table).** The two classes stay in
  the canon-ported theme file.
- ⚠ **The 320 px outer measurement MOVED with the markup.** In the modal, `.modal-scrim`
  was `overflow-y:auto` — CSS computes the other axis of a non-`visible` overflow to
  `auto` too — so the scrim absorbed every spill and `documentElement.scrollWidth` never
  moved; the load-bearing pair was SCRIM + ROW. In the page there is no scrim, so the pair
  is ROW + DOCUMENT. Copying the old assertion verbatim would have measured nothing.
- ⚠ **„no `0.00 EUR` on the landing" is the wrong absence, and it reddened on the real
  thing:** an OPEN landing's cartbar legitimately prints an empty cart's total (measured:
  3 matches). What must be absent is the BALANCE's vocabulary — `Nedoplatok`,
  `Môj účet`, `balance-amount`, `pay-balance`.
- ⚠ **A `shop` landing whose state is `closed` mounts `LandingStateModal` automatically**,
  and its scrim intercepts the appbar's Menu click. `portal-balance.spec.js` stubs
  `GET /friends/cycles` to ONE completed round so `dismissLandingState()` is always
  applicable, and enters `/zostatok` by URL for everything except the one test that pins
  the drawer entry point §UC-PI-019 item 9 names.
- **No `.card.flat` wrapper around the ledger**, though `portal2.jsx:236` has one: the
  lifted `.suborder` is already a bordered, shadowed card and wrapping would double-frame.
- **PI-T5's „the session mounts NO second PaymentModal" pin reddened, correctly**, and was
  rewritten rather than deleted: the session's one mount is now the BALANCE's (pinned by
  `:amount="balancePayment.amount"`), and `payOwnOrder()` still reaches FriendOrder's own.

### What PI-T7 LEAVES BEHIND

1. **PI-T8/T9 inherit a session that owns the money state.** `balance`, `balancePayment`,
   `balanceLoading`, `balanceError`, `canPayBalance`, `openBalancePayment()` are all
   session-level and all destroyed by the parent's `v-if` + `:key` on logout.
2. ⚠ **PI-T12's `portal-fidelity` A10 list should gain the balance card's 38px
   `.display`** — it carries an inline `line-height:1`, for the reason every `.display`
   on this surface does — and should decide whether to retire `CANON.negPill` outright.
   **✔ DISCHARGED by PI-T12 §1 (pinned at 38px, the canon's `1`) — and `negPill` is
   RETIRED: nothing read it; the record lives in `friends-theme.css` §A10's table.**
3. **Module 21 (messages) quotes `balancePaymentBlock()`.** The note now lives in
   `FriendBalanceCard.vue`'s header AND in the session's mount comment, because the
   reader composing a debt message may be looking at either.
4. ⚠ **PI-T11's vocabulary sweep gains `DebtBanner.vue`** (its copy is „Nedoplatok
   {suma}" + „Zaplatiť", no „kolo") and `FriendTransactionList.vue`. The prototype's
   „z minulého kola" is dropped by 18 resolved conflict 1 — which is also why the
   sweep finds nothing there.

---

## PI-T8 — the explainer, the roasters library, and a badge that had to stop lying (2026-09-20)

**What shipped.** `frontend/src/lib/roasters.js` (ONE home, two roasters, `roasterFor()`);
`frontend/src/components/PortalExplainer.vue` (the whole `/ako-to-funguje` view, with the
`asGate` prop PI-T9 flips); six `I2` glyphs (`pause`/`bell`/`cup`/`truck`/`box`/`hand`) in
`components/neo/icons.js`; the product card's roastery badge turned into a popover trigger
in `FriendOrder.vue` (one `NeoModal`, `v-if`); the mount + `explainerParcelEnabled/Fee` in
`FriendPortalSession.vue`; `e2e/tests/portal-explainer.spec.js` (24 tests) and ONE
sanctioned retarget in `order-product-card.spec.js`.

### 1. ⚠⚠ THE LIVE TIMELINE IS NOT MOUNTED HERE, AND IT WILL KEEP LOOKING LIKE A BUG

`CycleTimeline.vue` renders the same six steps with the same words. Every reader's first
instinct — mine included — is that the explainer „should" show it. §UC-PI-012 item 3
forbids it, and the reason is worth writing down because the spec only states it:

> the explainer describes the PROCESS in general; the timeline reports where ONE
> particular round is now.

Phase 1 is literally „Väčšinu času sa neobjednáva", i.e. the page's most common reader has
no round in flight at all, and a timeline would be wrong on exactly those visits. So the
six phases are STATIC TEXT owned by `PortalExplainer.vue`.

Because „someone will later fix this", §1 of the spec makes it a red run **in both
directions**: a source pin (`PortalExplainer.vue` contains no `cycle-stages`,
no `CycleTimeline`, no `timelineSteps`) and a DOM pin that is NON-VACUOUS — the same test
first visits a LOCKED landing and asserts `data-testid="cycle-timeline"` VISIBLE, then
navigates to the explainer and asserts it absent. ⚠ The non-vacuity half needs
`hasOrder: true` in the stubbed cycle row: a locked landing with no own order gets
§UC-PI-007's state MODAL and no timeline, so my first version failed on its own fixture and
would have „passed" as an absence test for entirely the wrong reason had I written the
absence alone. Mutation M8 (mounting `CycleTimeline` beside the explainer) reds it.

### 2. `lib/roasters.js` — a one home whose interesting half is the NON-consumer

Two entries, `roasterFor(name)`, dependency-free plain ESM so a Playwright worker imports
it directly (the `history-badges` / `cycle-stages` / `payment-links` precedent — this repo
has no unit runner and that import IS the unit test).

⚠ **The boundary is MEASURED, not asked for.** „Admin surfaces never import it"
(§UC-PI-014) is the kind of claim this repo has shipped wrong three times in a week — PI-T7
declared a single home in four documents while the rule lived in three files, and the
copies with no boundary fixture were the ones that drifted. So §7 of the spec walks
`frontend/src`, collects every file matching `from '…lib/roasters'`, asserts the importer
SET equals `{PortalExplainer.vue, FriendOrder.vue}` **and** asserts the boundary shape
(no `views/Admin*`, no `components/ui|analytics`) so GL-T4 can add `GuestRoastersLine.vue`
to the set without weakening the rule. Non-vacuity: the walk is asserted to have found
`views/AdminFriends.vue`. Mutation M11 (an import added to `AdminCatalog.vue`) reds it.

⚠ `roasterFor` is TYPE-SAFE rather than the spec's literal `String(name).trim()`:
`products.roastery` is nullable, so `null`/`undefined` arrive on most products, and
`String()` throws on a `Symbol`. Everything a real roastery value can be behaves
identically. The regexes are ANCHORED (`/^robo$/i` — „Robo Coffee" is somebody else) and
NOT global (a `/g/` flag carries `lastIndex` between `.test()` calls, so the second Robo
card in a grid would silently lose its popover; pinned as the behaviour AND as the flag).

### 3. ⚠ THE BADGE CHANGE BROKE A SHIPPED PIN, AND THAT WAS THE POINT

`order-product-card.spec.js` asserted „the roastery badge is always `acc-o`". §UC-PI-014
splits that: Goriffee PLAIN, Robo `acc-o`, an **unknown** roastery keeps today's `acc-o`.
One sanctioned edit, made in place with the supersession recorded, plus a strengthening
(`role="button"`). All three cases live in `portal-explainer.spec.js` §6.

⚠ `role="button" tabindex="0"` go on the badge **only on a match**. An element that
announces itself as a button and does nothing is worse than a plain `span` — and the admin
types `products.roastery` as free text, so an unrecognised roastery is the ORDINARY case,
not an error. Both halves are pinned because they fail independently: M5 (unconditional
`role`) and M6 (dropping the JS guard in `openRoaster()` so a DISPATCHED click opens an
empty modal) red the same test for two different reasons. A `disabled`/absent `role` never
stops a dispatched click reaching a handler — CLAUDE.md's standing rule, and the reason the
guard is in JS as well as in the binding.

### 4. `asGate` — the seam, and what PI-T9 must NOT have to touch

The gate is not a second screen; it is this page with a checkbox. `asGate` (default
`false`) changes exactly two things: the pre-ticked „Už mi to neukazovať" row appears, and
the one button's label becomes „Rozumiem, idem na ponuku" instead of „Späť na ponuku". The
component EMITS `done` with `{ hide }` and navigates nowhere — routing stays in
`FriendPortalSession.vue`, where every other `router.push` on the authenticated surface
already lives, and PI-T9's `markExplainerSeen()` goes in `onExplainerDone()`.

⚠ **PI-T9 edits `FriendPortalSession.vue` only.** It must not have to touch
`PortalExplainer.vue` or `lib/roasters.js`.

⚠ The gate's LIVE behaviour is deliberately NOT tested here: nothing mounts the component
with `as-gate` yet, so a test asserting the checkbox is on screen would be asserting a
screen no route reaches. What IS pinned is the seam's SHAPE (prop default, the pre-tick,
both labels on one button, the emit payload) plus ~~the fact that the session passes NO
`as-gate` today~~ — which is what makes the „from the menu there is no checkbox" assertion a
property of the app rather than of a default. M9 (`default: true`) reds both.

⚠ **Superseded by PI-T9 (§PI-T9 below):** the session now binds `:as-gate="explainerGate"`.
The „from the menu there is no checkbox" assertion is STILL a property of the app rather
than of the default — but for a different reason: `explainerGate` is seeded once at setup
from the login payload and lowered on the way out of the view, so a menu visit binds
`false`. The spec file's copy of this claim was amended at the same time; a reader who
finds only one of the two has found a stale copy.

### 5. Measured, and easy to get wrong

- ⚠ **§UC-PI-012's own acceptance criterion is slightly wrong and the spec is not.**
  `getByRole('heading', { name: /Káva pod pultom, spolu\./ })` does NOT resolve: Chromium's
  accessible-name computation inserts a space at each inline element boundary, so the real
  name is „Káva pod pultom **, ** spolu." — a space BEFORE the comma. The claim the
  criterion is making (one heading, not three sibling elements) is true and is what the
  spec pins, with `\s*` tolerance and a `.p2-hl` assertion beside it. Recorded rather than
  „fixed" at the markup.
- ⚠ **The Packeta fee reads `currentCycle ?? catalogCycle`, and the `??` is load-bearing.**
  `resolveLanding().currentCycle` is NULL under `closed` (PI-T1 §2) — and a friend with
  nothing to order is exactly the one reading how it works, so `currentCycle` alone hides
  the fee on the majority of visits to this page. M7 reds it. Badge OFF means NO badge at
  all: Packeta being unavailable is not a price of zero (M4 reds the both-directions test).
- ⚠ **`api.getPickupLocations('coffee')` — the ARGUMENT is the point.** Without it the
  endpoint answers every active point, bakery-only ones included, i.e. places no coffee
  round ever offers. The spec stub RECORDS the URL it was asked for; M3 reds it.
  It is the CHOOSABLE feed (`active = 1`), never `helpers/pickup.js pickupOf()`'s
  „where is THIS party's bag going" — the two questions are the FUP-T25 pair.
- A failed pickup feed is INDISTINGUISHABLE from an empty one (both render „Odberné miesto
  si vyberáte pri objednávke."), and no page banner appears. An explainer is no place for
  an error surface.
- The three-zone checkbox row (`@click.self` on the label, `@click` on the span, the box's
  own handler) was COPIED from `FriendPortal.vue:1248`, not re-derived: a `<label>` only
  forwards clicks to labelable elements and `NeoCheckbox` is a `span[role=checkbox]`.
- The six glyphs went into `components/neo/icons.js` with the prototype's per-icon
  `linecap`/`linejoin` — which is NOT uniform (`pause` caps but does not join, `truck`/`box`
  join but do not cap). An unknown `NeoIcon` name renders NOTHING and is silent in
  production, so each phase's `.ico svg` is asserted present (M12, deleting `cup`, reds it).

### 6. The gate, and the twelve mutations

`portal-explainer.spec.js` (24) · `order-product-card` · `portal-shell` · `portal-menu` ·
`portal-appbar` · `portal-landing` · `portal-fidelity` · `cat-scroll-arrow` ·
`portal-subscription-invite` · `order-modals` · `product-photo-lightbox` ·
`self-hosted-fonts` — **12 asked, 12 ran, 236 passed, 0 failed, exit 0**, reconciled with
`grep -oE 'tests/[a-z0-9-]+\.spec\.js'`. Server log read first: 0 error lines.

| mutation | reds |
|---|---|
| M1 Goriffee `badgeClass: 'acc-o'` | lib labels + the Goriffee card test + `order-product-card` |
| M2 anchors dropped from both regexes | `roasterFor()` matrix |
| M3 `getPickupLocations()` without `'coffee'` | the pickup row test |
| M4 Packeta badge ungated | the both-directions gate test |
| M5 `role="button"` unconditional | unknown-roastery |
| M6 `openRoaster()`'s guard removed | unknown-roastery (a DISPATCHED click) |
| M7 `catalogCycle` fallback dropped | the closed-landing fee test |
| M8 `CycleTimeline` mounted on the explainer | §1's absence test |
| M9 `asGate` default `true` | the menu-mode test + the seam source pin |
| M10 one PO text re-worded | the byte-for-byte text pin |
| M11 `AdminCatalog.vue` imports the lib | the admin-invariance sweep |
| M12 the `cup` glyph deleted | the six-phases glyph test + the icon-module pin |

⚠ Each mutation was applied from a scratchpad backup, **verified to have changed the file**
(the harness `cmp`s and aborts otherwise), rebuilt into `backend/public`, run, and
reverted — a mutation that never reaches the served bundle proves the opposite of what it
looks like.

### What PI-T8 LEAVES BEHIND

1. **PI-T9 (`§UC-PI-013`) edits `FriendPortalSession.vue` and nothing else on this side:**
   pass `:as-gate="explainerPending"` at the ONE `<PortalExplainer>` mount and read
   `@done`'s `{ hide }` in `onExplainerDone()`. The seam's shape is source-pinned, so
   moving it is a red run.
2. **GL-T4 (module 19) imports `lib/roasters.js`** for `GuestRoastersLine.vue` and adds
   `cup`/`box`/`hand` mounts — the glyphs are already in `icons.js`, so it adds NO icons.
   It will need to extend the §7 importer-set assertion by one entry; the boundary half of
   that test is written so it does not have to be weakened.
3. **PI-T11's vocabulary sweep gains `PortalExplainer.vue`** — its copy contains no
   „kolo"/„cyklus" (checked with the then-current `/\bkol[oáa]|cykl/iu` regex; the ban's one home is now
   `e2e/helpers/vocabulary.js BANNED`, PI-T11) and the personal note is
   APP copy, deliberately NOT `[data-user-copy]`.
4. ⚠ **Four `OPEN:`s in §UC-PI-012/014 are now SHIPPED as their defaults**, all of them the
   PO's to polish later and none of them a call-site decision: the WhatsApp mention in
   phase 2, „(PayMe)" in §Ako platím, the „— Karol" note, and both roaster texts. Reproduce,
   never improve — a reader who „tidies" one of them is editing the product owner's voice.

---

## PI-T9 — the first-login gate, and a suite-wide exposure that was real but 4× smaller than counted (2026-09-21)

**What shipped.** `friends.explainer_seen_at` (try/catch ALTER, **no back-fill**);
`POST /api/friends/:id/explainer-seen` (owner-guarded, shared-password 401, `COALESCE`);
the field on all FOUR login payloads (`friends.js` ×3, `magic-link.js` ×1);
`api.markExplainerSeen()`; `beginSession({ explainerPending })` + the three login call
sites in `FriendPortal.vue`; `explainerGate` + the `router.replace` + `onExplainerDone
({ hide })` + `:as-gate` in `FriendPortalSession.vue`; `e2e/seed.mjs` step 6/7 (the gate
fixture + the 77-friend pre-stamp); `helpers/portal.js ackExplainer()`;
`portal-explainer.spec.js` §9/§10 (12 new tests) plus THREE sanctioned fixture edits.
**`PortalExplainer.vue` and `lib/roasters.js` were not touched** — PI-T8's seam held.

### 1. ⚠⚠ THE 71-FILE EXPOSURE: WHAT IT REALLY IS, MEASURED THREE WAYS

The row was handed „**71 spec files log a friend in**, every one a candidate to break".
That number is real and it is the wrong population. Measured over `e2e/tests/*.spec.js`
(91 files):

| how a spec signs a friend in | files | can the gate fire? |
|---|---|---|
| `POST /api/friends/auth` from an `APIRequestContext` | **70** | **NO** — no browser, no `beginSession`, nothing reads the payload |
| `localStorage.gorifi_friend_auth` + `goto` (a RESTORE) | **32** | **NO** — §UC-PI-013: a restore is not a login |
| the login CARD, in the page (`zadajte heslo` / `užívateľské meno` / `pp-login-username` / `vyberte svoje meno`) | **15** | **YES** |

(The three overlap; 74 files do at least one.) The 70 is almost certainly where „71"
came from — `grep -rl "api/friends/auth"` — and it counts the population that is
structurally immune, because the gate lives in `FriendPortal.vue`, not in the response.

**And the 15 is an upper bound on the exposure, not the exposure.** `expectLanding()`
resolves `data-testid="portal-landing"`, which PI-T1 put on the page COLUMN — present in
all four views, the explainer included. So the „portal is ready" gate that 28 files share
**passes on the explainer**, and a spec only breaks if it then asserts something
view-specific. Measured on the real thing: of the first EIGHT files (alphabetical) in the
targeted run, six were green including `first-password` and `forced-change-ui`, which DO
log in through the card — they assert modals, and a modal sits over any view. Only
`friends-consolidation` (6) and `google-auth` (13) reddened.

⚠ **What actually breaks is narrower and worth naming: the drawer.** §UC-PI-003 puts a
BACK CHEVRON where the hamburger is on the explainer view, so `openMenu` / `logout` /
`openProfile` / `expectChromeName` — every `helpers/portal.js` function that goes through
the drawer — time out on actionability. Both failing files fail that way. A spec that
logs in and reads the screen is fine; a spec that logs in and opens the MENU is not.

### 2. ⚠⚠ `seed.mjs` CANNOT CONTAIN THIS ALONE, AND THE BACKLOG ROW SAYS IT CAN

The instruction („`seed.mjs` pre-stamps every seeded friend except one dedicated
fixture") assumes the suite logs in as SEEDED friends. It does not: measured, **every one
of the 15 card-login files provisions its own friend** through `POST /api/friends` during
the run, and `POST /api/friends` writes no acknowledgement (rightly — a brand-new friend
IS a first-login friend). `seed.mjs` runs once, before any of them exist.

So the containment is TWO mechanisms over two populations, and saying so is the finding:

1. **`seed.mjs` step 7** — the 76-friend template + `E2ETester` = 77 rows stamped, i.e.
   the gate DATABASE put into the state a live deployment reaches once everyone has
   logged in once. One named row, `E2EExplainerGate`, is left NULL.
2. **`helpers/portal.js ackExplainer(ctx, {id, token})`** — for friends created DURING a
   run. It POSTs the REAL route with the friend's OWN session, so a dozen fixtures
   round-trip the endpoint incidentally.

⚠ **Step 7 is a DB write and there is no API that could replace it.** The route is
owner-guarded on purpose, so stamping 77 friends through it means minting 77 friend
sessions — 154 requests on `authLimiter`, whose production default is 20/window. An admin
endpoint was the other option and is worse: §UC-PI-019 item 16 says nothing in this module
joins `ADMIN_ENDPOINTS`, and a server-side back door for a per-friend acknowledgement is
the exact boundary the route's guard exists to hold. It is gated on `DB_PATH` so the
script stays target-agnostic — **and that gate is the new silent-skip trap**: without
`DB_PATH` the seed prints one line and every card login in the suite lands on the
explainer. Recorded in `CLAUDE.md` and in `e2e/README.md` step 5, with the exact line a
correct run prints.

### 3. ⚠⚠ THE BUG THIS ROW CREATED AND THEN CAUGHT: `DB_PATH` WITHOUT ITS `BASE_URL`

The first gate run reddened `portal-explainer.spec.js` §10 with „the DEDICATED fixture is
deliberately NULL — Received: 2026-09-21 00:17:45", i.e. `E2EExplainerGate` was stamped
**14 seconds into the run**, by nothing that appears in any spec file. Traced by reading the
database rather than the code: the stamps arrive in BULK (77 rows at one second, then 9,
then 60, then 35), and the only bulk `UPDATE … WHERE explainer_seen_at IS NULL` in the tree
is `seed.mjs` step 7.

**`e2e/mailgun-harness.js startBackend()` runs `seed.mjs` against every throwaway backend
it spawns, with `env: { ...process.env, BASE_URL: baseUrl }` — and `DB_PATH` inherited.**
That was harmless for two years because `seed.mjs` was a pure HTTP client: the ambient
`DB_PATH` (the SHARED gate database, exported by the run recipe) was inherited and ignored.
Step 7 made the script write to `DB_PATH` directly, so every one of those spawns seeded a
throwaway backend over HTTP and then pre-stamped **the gate database** — including the one
row the seed must leave NULL.

**The invariant, now load-bearing and now written down: `DB_PATH` names the database that
`BASE_URL` is serving.** Fixed at both ends, deliberately:

1. the harness passes `DB_PATH: dbPath` (its own file) to the seed spawn — correct by
   construction, and the throwaway gets its own pre-stamp;
2. `seed.mjs` VERIFIES the pairing before writing: the API just told it which id
   `E2EExplainerGate` has on the target, so a database where that id holds a different name
   (or no row) is somebody else's, and the step skips with a `!!` line naming both paths.

⚠ Proved in both directions, and the FIRST attempt at proving it was worthless: pointing
`DB_PATH` at an older *seeded* copy did NOT trip the guard, because that copy has the same
fixture at the same id — two databases seeded identically are indistinguishable by this
correlation. The real case is not: a throwaway backend starts EMPTY, so its
`E2EExplainerGate` is id 2, not 80. The shipped proof uses a raw `prod-template.sqlite`
copy (no id 80 at all) → „is NOT the database … is serving (id 80 is absent there) —
pre-stamp SKIPPED", and the stranger file still has **no `explainer_seen_at` column at
all** afterwards, which is the strongest possible „nothing was written".

### 4. ⚠ „Rozumiem" IS NOT THE GATE'S ONLY EXIT — THE BACK CHEVRON IS

My own §9 test („re-entering from the drawer in the same session shows no checkbox")
reddened against the first implementation, and it was right. §UC-PI-003 puts a BACK CHEVRON
where the hamburger is on the explainer view, so the friend can leave the gate WITHOUT
answering it — and `explainerGate` was lowered only inside `onExplainerDone`. After that
escape the flag stayed raised, so an explainer the friend later opened FROM THE DRAWER still
carried the pre-ticked „Už mi to neukazovať" and would have STAMPED the column on
„Rozumiem" — the one thing §UC-PI-013 forbids in as many words.

Fixed with a watch on the VIEW, not on the button: `before === 'explainer' && now !==
'explainer'` ⇒ the gate ends. ⚠ The simpler predicate (`view !== 'explainer'`) is wrong and
would have looked right: the session mounts on `shop` and `router.replace` lands a tick
later, so it fires once at mount and lowers the flag before the gate has ever rendered.

### 5. ⚠ THE `active = 1` 404 IS UNREACHABLE THROUGH THE API — AND SAYING SO IS THE TEST

„A deactivated friend gets the 404" was written, run, and came back **401**: the admin
`PATCH /:id { active: 0 }` INVALIDATES the friend's sessions, so the Bearer token is dead
before `requireFriendOwner` can resolve anybody, and ownership is checked before the row
lookup. Same shape as CS-T1 §2's unreachable `stage IS NULL` row, and handled the same way:

- the API path is pinned as the **401** it really is, with the reason at the assertion;
- the predicate is proved load-bearing by a `DB_PATH`-gated BUILT SCENARIO — `active = 0`
  written straight into the row, leaving the session alive ⇒ 404 with the exact message —
  and the non-vacuity half flips `active` back and gets a 200 from the same request.

### 6. THE SANCTIONED SPEC EDITS: TWO CONTRACTS AND EIGHT FIXTURES

**Two are CONTRACT retargets** (03 UC-FL-013 case (a)) — an EXACT key set on a login
payload, which §UC-PI-013 mandates a sixth key on:

- `google-auth.spec.js` §UC-GA-003's `Object.keys(body.friend).sort()`;
- `magic-link.spec.js` UC-ML-005's, beside its raw-text `SELECT *` sweep.

The protected property is untouched in both, and it is the reason the lines stay exact sets
rather than `toContain`: a hand-picked literal turning into a spread must still red, and it
still does (`password_hash`, `access_token`, `invite_code`, `google_sub`, `display_name`,
`phone`, `email` all live on that row). Both now also assert the value is `null` for a
friend who has never acknowledged it, so the key is not merely present.

**Eight are FIXTURES** — the containment of §2, applied where it was MEASURED to be needed
rather than everywhere it might be: `friends-consolidation`, `google-auth`
(`friendWithLogin` **and** `plainFriend` — two helpers, and the second was found only by a
second run), `magic-link`'s harness pairing, `portal-appbar`, `portal-landing`,
`portal-menu`, `portal-profile-modal`, `portal-session-boundary`.

⚠ `portal-session-boundary`'s `makePlainFriend()` needed the long way round and is worth
knowing: that friend has NO credentials, so there is no personal login to mint a session
with, and `ackExplainer` needs the friend's OWN token. The LEGACY shared-password branch of
`POST /friends/auth` mints a per-friend session for exactly this case — the same fact
`requireHost`'s comment relies on — and it is the only token that can acknowledge the
explainer on their behalf.

### 7. ⚠ FOUR LOGIN PAYLOADS — AND A FIFTH MINT SITE THAT IS NOT ONE

The spec names `friends.js:173/230/358` and `magic-link.js:406`; all four are real and
all four carry the field.

⚠ **Found in review, after the count was already written: there is a FIFTH place that
mints a friend session — `routes/onboarding.js` (invitation registration).** The grep the
spec prescribes cannot see it, because the reason it is not a login payload is that it has
no `friend: {` at all: it answers four flat fields, `OnboardingPage.vue` assembles
`gorifi_friend_auth` from them and routes to the portal, so the friend arrives by the
RESTORE path. Consequence: **the most newcomer-ish moment in the app does not open the
newcomer gate.** That is uncomfortable and it is still right — adding the field there
would make every reload re-open the gate. The fix, if the product wants it, is a ROUTE
from `OnboardingPage.vue`, not a field. Noted at the site and in §UC-PI-013.
⚠ The general lesson: **„the guard is a grep" only enumerates the sites that share the
shape the grep matches.** A site that is out of scope BECAUSE it has a different shape is
invisible to it by construction, so it has to be written down. `onboarding.js` was found by
asking „what calls `createFriendSession`?", which is the question the shape-grep cannot ask. **`magic-link`'s has no client consumer, deliberately**: a
redemption reaches the portal through `MagicLogin.vue` + the localStorage RESTORE path,
and routing the flag through the stored payload would re-open the gate on every RELOAD —
precisely what „a restore is not a login" forbids. A magic-link friend meets the explainer
at their next ordinary login, stamp still NULL. Written at the site so it is not „fixed".

⚠ `?? null` on every site, not a bare read: on a backend whose migration has not run the
column is `undefined` and `JSON.stringify` DROPS the key, so the client's `=== null` would
see `undefined` and decide „not a login" — correct, but by accident.

⚠ The grep the spec prescribes (`grep -n "friend: {" backend/src/routes/*.js`) returns
**12 lines in four files**, not four — and every one of the eight non-login hits had to be
read to be excluded, which is the step that keeps the rule „logins only": `orders.js`
:156/:308/:326/:476 (ORDER payloads), `invitations.js`:773 (the admin's approve response,
plus a doc comment at :493), `friends.js`:859 (`set-password` — a CREDENTIAL route reached
by an already-authenticated friend, so the gate decision is long made), and, since this
row, the comment at `friends.js`:175 that names the set. **Counting the grep is not the
same as reading it** — this file has recorded that failure four times (PI-T1 §3, PI-T2 §4,
PI-T3 §3 and §10), so the count is written out per file here.

### 8. ⚠ THE ALTER PLACEMENT WAS MEASURED, AND CS-T1's TRAP DOES NOT APPLY HERE

CS-T1's lesson is that `order_cycles` is RECREATED from a hard-coded column list, so an
`ADD COLUMN` above that block is silently dropped. **`friends` has no such block**, and this was
COUNTED: `grep -n "_new " backend/src/db/schema.js` returns **8 lines** — six that are the
two recreates (`order_cycles_new` ×3, `order_items_new` ×3), one that is the new comment
saying so, and one unrelated `is_new` COLUMN in another table. Neither recreate touches
`friends`. Verified rather than assumed, which is the whole point of that lesson; the ALTER sits at
the end of the sixteen friends migrations, and the column is deliberately NOT added to
`CREATE TABLE IF NOT EXISTS friends` — that statement is the original 2024 shape and every
column since `active` arrives by ALTER. Splitting that convention per column is how the
fresh-database and migrated-database paths start to disagree.

### 9. `explainerGate` IS A REF, NOT A COMPUTED — AND THAT IS A BEHAVIOUR, NOT A STYLE

A `computed(() => props.entry?.explainerPending)` reads identically and is wrong: the flag
has to stop being true the moment the gate is ANSWERED, because the friend can re-open the
explainer from the drawer in the same session and §UC-PI-013 says a menu-opened explainer
writes nothing and shows no checkbox. `PortalExplainer` emits `{ hide }` in BOTH modes
(one payload shape) and `hide` defaults to `true`, so a handler that read the payload
without checking the gate flag would stamp on every menu visit. Pinned behaviourally
(„re-entering from the drawer in the same session shows no checkbox", and it counts the
POSTs) and in source.

### 10. PRECEDENCE IS STRUCTURAL — AND CODING IT WOULD HAVE INVERTED IT

§UC-PI-013 orders forced-password-change → Google prompt → explainer. Both of the first
two are `NeoModal`s over whatever view is mounted, so the `router.replace` is
UNCONDITIONAL and the explainer simply waits underneath. ⚠ The tempting
`if (!forcedPasswordChange)` guard inverts the rule: the friend would finish the forced
change and land on the SHOP, having never been shown the page the gate exists to show
them. The test asserts BOTH halves in one document — the gate modal visible AND the URL
already `/ako-to-funguje` — because either alone is satisfied by the wrong build.

### 11. Small things measured rather than assumed

- **`router.replace` — the spec's reason was wrong, and so was the first correction.**
  §UC-PI-013 said „replaced … so back goes to `/`"; a replace does the opposite. The
  orchestrator then substituted „the friend did not ask for this URL, so it must not be a
  back destination" — also wrong, twice over: `replace` removes `/`, not `/ako-to-funguje`,
  and under `push` the back destination WOULD be `/`, the one URL the friend did ask for.
  ⚠ **The checkable reason, found in review:** `push` leaves a ONE-TAP BYPASS. `explainerGate`
  is raised once at setup and the exit watch lowers it on any transition out of the view, so
  back → `/` → `shop` ends the gate UNSTAMPED, and the ref cannot re-raise. Three copies
  carried a justification that did not survive checking; the word `replace` was right
  throughout. **A rationale is a claim — „the word is correct" is not evidence that the
  sentence after it is.**
- **The idempotency test waits 1.2 s.** `datetime('now')` is second-resolution, so two
  calls in the same second agree even WITHOUT `COALESCE` — the pin would have been
  vacuous. Same family as CS-T2 §4's „an assertion that names no timezone measures
  nothing".
- **Every refusal test READS THE ROW BACK.** A 401 that wrote anyway is indistinguishable
  from a 401 that did not, from the status line. The shared-password test also carries a
  NON-VACUITY half: the same header on the same deployment still authenticates
  `GET /:id/balance` with 200, so the refusal is about identity and not about a typo.
- **The 404 is only reachable for a DEACTIVATED friend.** Ownership is checked first, so
  an unknown id presented with a friend's own token is a 403, never a 404. The test says
  so rather than asserting the 404 it looks like it should.
- **`GET /friends/:id/profile` already publishes the column** (`SELECT *` +
  `sanitizeFriend`, credentials only) and that is fine — it is the fire-and-forget
  hydrate, and nothing re-derives the gate from it.

### 12. The gate, and the asked-versus-ran reconciliation

`portal-explainer` · `api-security` · `admin-friends-labels` · `email-templates` ·
`first-password` · `forced-change-ui` · `magic-link` · `neo-control-metrics` ·
`portal-landing` · `portal-profile-modal` · `portal-session-boundary` ·
`friends-consolidation` · `invitation-approval` · `modern-login` · `portal-appbar` ·
`portal-menu` · `google-auth` · `portal-shell` · `portal-history` · `portal-balance` ·
`order-shell` · `share-dialog` · `colleagues-panel` · `guest-host-view` — **24 asked, 24
ran**, reconciled by diffing the asked list against
`grep -oE 'tests/[a-z0-9-]+\.spec\.js' | sort -u`, behind a pre-flight `[ -f ]` check on
every entry (a list where one name matches nothing is silent and exits 0).

**Final: 698 passed, 0 failed, 1 skipped, 6.3 min**, on a per-run copy of
`prod-template.sqlite` with all five limiter maxima at 100000 and the frontend built into
`backend/public` first. The one skip is the documented `forced-change-ui.spec.js`
`test.fixme`. **Server log read BEFORE the test log**, per CLAUDE.md: one line, the
`Error: Not allowed by CORS` that `api-security`'s own CORS test provokes.

⚠ The number to compare against is the FIRST run of this tree: **16 failed / 681 passed**,
in the six files §1 and §3 explain. Every one of those failures was a real consequence of
the feature, not a flake — which is why the row is written up the way it is.

The set is deliberately wider than „the files I edited": it carries **all 15 friend
card-login files** and a sample of the restore-path ones, because §1's exposure is the
row's real risk.

⚠ **One flake, confirmed as one** (CLAUDE.md's rule, applied): `magic-link.spec.js:1174`
(a throwaway-backend test) failed once inside the 24-file batch and passed **73/73 twice
running alone**, on the same tree and the same database.

### 13. The mutation matrix (every one applied from a scratchpad copy, `cmp`-verified to have changed the file, rebuilt into `backend/public` or the server restarted, run, then reverted)

| # | Mutation | Reds |
|---|---|---|
| M1 | the route's shared-password `friendId == null` 401 removed | 1 — „shared-password auth resolves NO identity", alone |
| M2 | `COALESCE` → a bare `datetime('now')` | 1 — the idempotency test, alone |
| M3 | the RESTORE path passes `explainerPending: true` | **6** — my restore test **plus five PI-T8 tests** that sign in through localStorage and then read the explainer and the product cards. That spread IS the evidence for §1: „a restore is not a login" is what keeps 32 spec files measuring their own screen |
| M5 | `onExplainerDone` reads `hide` WITHOUT the gate check | 1 — the one-shot test („a menu-opened explainer never writes") |
| M6 | the gate navigates nowhere (`router.replace` removed) | **5** — every gate test that expects `/ako-to-funguje`, precedence included |
| M7 | `seed.mjs` step 7 stamps the fixture too (`id <> -1`) | 1 — §10, plus the seed's own `!!` line („expected exactly 1 unacknowledged friend, found 0") |
| M9 | `explainer_seen_at` dropped from the SHARED-PASSWORD login payload only | 1 — the four-payload test, alone (the personal branch still carried it) |
| M11 | `explainerGate` as a COMPUTED over `props.entry`, with the lowering removed | 2 — the seam source pin **and** the one-shot test, i.e. the style trap of §9 fails behaviourally too |
| M12 | the §4 exit watch removed (back-chevron escape leaves the gate raised) | 1 — the one-shot test, alone |
| M13 | `helpers/portal.js ackExplainer()` made a no-op | **4** — the two `portal-menu` session-scoping tests and the two `portal-profile-modal` ones, i.e. exactly the tests §2's containment was introduced for |

⚠ M1/M2/M9 need a SERVER RESTART and M3/M5/M6/M11/M12 need a REBUILD into `backend/public`
— a mutation that never reaches the running process proves the opposite of what it looks
like (PI-T8 §6's rule, and the harness `cmp`s and aborts rather than trusting the edit).

### 14. THE REVIEW PASS: SIX MINORS, AND FOUR OF THEM WERE DOCUMENTATION

Review returned **approve with six minors**, no blockers and no majors. What they were is
more interesting than the verdict, because five of six are the same failure in different
clothes — **a sentence that was true when written and was not re-checked after the thing
it describes moved**:

1. `PortalExplainer.vue`'s PI-T8 seam comment predicted `:as-gate="explainerPending"`;
   the shipped binding is `explainerGate`. The prediction was right about the SEAM (the
   file was not touched) and wrong about the expression, and the difference is behavioural,
   not cosmetic: binding the prop would re-arm the gate on every menu visit. Both the
   component comment and §4's „the session passes NO `as-gate` today" were superseded —
   the spec copy had been amended during the row, the other two had not. **Third time in
   this module that an amendment reached one copy of three.**
2. The `router.replace` rationale, twice wrong — see §11's first bullet and the three copies.
3. The API refusal test was titled „… an unknown friend is 404" and asserts **403**. §5
   had already measured and explained the 403; the TITLE and §UC-PI-013's own „404
   unknown/inactive" bullet were the copies that did not get the news. A title is a claim.
4. `seed.mjs`'s pairing check says it fails „LOUDLY" and did so with a `console.log` and
   exit 0 — while the ONE caller the check exists for (`mailgun-harness.js`) spawns it
   with `stdio: 'ignore'`. **„Loud" is a property of the listener, not of the speaker.**
   Now: `process.exitCode = 1` on the mismatch, and the harness reports a non-zero seed
   exit on its own stderr.
5. `e2e/README.md` said the step stamps „all 76 template friends"; the run prints **77**
   (76 template + the seed's own `E2ETester`, with `E2EExplainerGate` the 78th and the one
   left NULL). The seed COUNTS rather than assumes, so the code was right and only the
   prose was off — but the prose is what a reader compares the output against, and „77 ≠
   76" reads as a broken step. **An enumeration is a measurement** — the fifth time this
   file records that, and the first where the wrong number was in a README.
6. The fifth mint site (§7).

None of the six changed a line of shipped behaviour except 4's exit code. That is the
shape of this row: the implementation was small and the claims about it were where the
defects lived.

### What PI-T9 LEAVES BEHIND

1. ⚠⚠ **`seed.mjs` now needs `DB_PATH`, and losing it is SILENT** (§2). One line in the seed
   output is the whole tell: `explainer: pre-stamped N friend(s); 1 left unacknowledged`. The
   skip line (`DB_PATH not set`) and the mismatch line (`is NOT the database … is serving`)
   are both `!!`-prefixed, and `e2e/README.md` step 5 now carries the recipe.
2. ⚠ **`E2EExplainerGate` is a DELIBERATELY UNSTAMPED seeded friend**, and the next reader's
   instinct will be to „tidy" it into the bulk UPDATE. `portal-explainer.spec.js` §10 asserts
   one stamped and one NULL, scoped BY ID (`id < fixture.id` = „existed when the seed ran"),
   because every other spec creates friends of its own and never stamps them — „no unstamped
   friend anywhere" is false by construction the moment a second file has run.
3. **The magic-link login payload publishes `explainer_seen_at` with NO client consumer**
   (§7), on purpose. Plumbing it through `MagicLogin.vue`'s stored payload would re-open the
   gate on every reload.
4. ⚠ **PI-T10's profile modal auto-opens „until Mobil is filled", and its own row says
   „after the gates of PI-T9"** — so that modal has to sit behind the explainer the way the
   forced-password gate sits in front of it. The precedence chain is now three deep
   (forced-password → Google prompt → explainer → PI-T10's profile), and only the first
   three are implemented; PI-T10 owns adding itself to the end, not to the middle.
5. ⚠ **`routes/onboarding.js` is a fifth session mint and NOT a login payload** (§7) — a
   registering friend meets the explainer at their next ordinary login, not on the visit
   they registered in. Documented at the site; do not „fix" it by adding the field.
6. **`helpers/portal.js ackExplainer()` is the one home** for „this fixture friend is an
   established friend". A spec that hand-writes `explainer_seen_at` into the row is
   re-creating the problem — except where it genuinely cannot get a token
   (`google-auth`'s two helpers, which say so at the site).

---

## PI-T10 — the profile modal, a required field, and a trigger I deliberately narrowed (2026-09-21)

**Row:** PI-T10 · `18 §UC-PI-015`, `§UC-PI-019 items 10/11`, PO decisions 2026-09-19
(„Profile modal auto-open = YES", „Packeta address server bound = add 160",
clarification (c)).

**Shipped:** the profile modal's body reordered and relabelled per §19 (Login ·
Meno a priezvisko * · Mobil * · [module-21 slot] · E-mail · Adresa Packeta), „Mobil"
required on `PATCH /friends/:id/profile` **only**, a 160 bound on
`friends.packeta_address`, and the auto-open for a friend with no stored phone.

### 1. ⚠⚠ I NARROWED THE AUTO-OPEN'S TRIGGER TO A LOGIN, AGAINST THE ROW'S OWN NOTE

The row said: dismissal is a per-session `ref`, therefore „a RELOAD re-opens it — state
it explicitly and pin it." I pinned the opposite, and this is the one thing in the row a
reviewer must agree or overturn.

What I measured before deciding, over `e2e/tests/*.spec.js`:

| trigger | spec files that could meet an unasked-for modal |
|---|---|
| **session mount** (login OR restore) | **53** — the union of the 35 card-login files and the 33 that seed `localStorage` |
| **login only** (`entry.freshLogin`) | **16** — exactly PI-T9's card-login population |

53 files is not a containment job, it is a second row. But the size is the second
argument, not the first. Three others come before it:

1. **Clarification (c)'s own words**: „dismissible per session and **re-opens on the next
   login**". A reload is not a login anywhere else in this module.
2. **§UC-PI-013 already decided this**, in `beginSession`'s own comment: „A SESSION
   RESTORE IS NOT A LOGIN … a friend who has not acknowledged the explainer must not be
   dragged into it by every reload, only by a fresh login." The same sentence is true
   word for word with „the explainer" replaced by „the profile modal", and §UC-GA-006's
   Google prompt made the same call before it.
3. **The product consequence.** `FriendPortal.vue` restores on EVERY document load, so
   a session-mount trigger is not „once per reload" — it is a modal on every deep link,
   every bookmark, every share URL a phone-less friend opens. That is the behaviour two
   earlier rows in this module already refused.

So `beginSession` gained `freshLogin`, seeded from the three login paths exactly as
`explainerPending` is, and `FriendPortalSession` seeds `profileAutoOpenArmed` from it.
Both halves are pinned: a login opens it, a reload of that same session does not (with a
non-vacuity read of the row proving the phone really is still empty).

⚠ If the PO wants the reload behaviour after all, the change is ONE seed
(`ref(!!props.entry?.freshLogin)` → `ref(true)`) — and it owes the suite ~37 more fixture
phones. That is the trade, priced.

### 2. ⚠⚠ PRECEDENCE IS CODED HERE, AND PI-T9 SAYS NOT TO CODE IT — BOTH ARE RIGHT

§PI-T9.10 above records: „PRECEDENCE IS STRUCTURAL, AND CODING IT WOULD HAVE INVERTED
IT." That is about a `router.replace` to a VIEW: the forced-password gate and the Google
prompt are modals that paint over whatever view is mounted, so the explainer waits
underneath and an `if (!forcedPasswordChange)` would have skipped it entirely.

PI-T10's surface is a `NeoModal`. A modal opened while another modal is up does not wait
underneath it — it stacks, traps focus against its sibling and puts a scrim over a gate
the friend cannot dismiss. So here the gates are terms in the trigger, read REACTIVELY
(each clears in place, and this modal is meant to arrive at exactly that moment).

⚠ **Four terms, and the fourth is not in clarification (c):** `forcedPasswordChange`,
**`showCredentialSetup`**, `showGooglePrompt`, `explainerGate`. The credential-setup
dialog is the transition-mode `NeoModal` raised from the same handshake; omitting it
stacks this modal on top of it for a credential-less friend with no phone — which
`portal-profile-modal.spec.js`'s own „the CREDENTIAL-SETUP dialog must not open
pre-filled" test would have caught as a mysterious dialog count. Added deliberately and
said out loud rather than silently. ⚠ `showMagicPrompt` is NOT a term: it renders as a
`.banner`, not a modal, so there is nothing to stack on.

The gate test asserts BOTH halves in one document — the forced gate ALONE while it is up
(`getByRole('dialog')` count 1, `.modal-layer` count 1) and the profile modal arriving
the moment it clears — because either half alone passes on the wrong build.

### 3. ⚠ THE HYDRATE GATE IS A `hasOwnProperty`, AND A TRUTHINESS TEST WOULD HAVE SHIPPED A FLASH

`phone` is in NONE of the login payloads (PI-T9 pinned that set: six fields, four
payloads) and PI-T10 did not extend it — the row forbade it and there was no need. It
arrives through `hydrateCurrentFriend()`'s `GET /:id/profile`.

`!props.friend?.phone` is therefore TRUE for every friend for the first few hundred
milliseconds of every login, phone or no phone. The predicate is
`Object.prototype.hasOwnProperty.call(props.friend, 'phone')` — „do I know yet?" — and it
is also what places the auto-open last in the chain for free, since that fetch settles
after the gates have painted. Pinned by „a friend WHO HAS a phone is never interrupted",
which is the non-vacuity twin of the opening test: same login, same screen, one column
different.

⚠ A FAILED hydrate never auto-opens. Deliberate: that fetch is documented fire-and-forget
and allowed to fail silently; the cost of a miss is one more prompt at the next login.

### 4. THE BOUND WENT WHERE THE COLUMN'S ONE WRITER IS — WHICH I WALKED RATHER THAN ASSUMED

`friends.packeta_address` has **exactly one** writer in `backend/src`: the `UPDATE` in
`PATCH /:id/profile`. Walked, not guessed — every `UPDATE friends SET` (27 sites) and
every `INSERT INTO friends` (3 sites: `friends.js POST /`, `invitations.js` approve,
`onboarding.js` register). None of the three creation sites lists the column and no admin
route writes it (`ADMIN_FRIEND_FIELDS` has name/display_name/phone/email and nothing
else). ⚠ `orders.packeta_address` is a DIFFERENT column with its own rule in
`routes/orders.js`; a grep for the identifier hits both.

So the 160 lives in the profile handler beside FUP-T12's type rule, not in
`validateAdminFriendFields`. Same reasoning, opposite direction, for the required phone:
that validator is SHARED, and the admin must still be able to clear a phone — so the
required check is in the handler, and **both halves are pinned** (the friend route
refuses; the admin route clears and the row is read back).

### 5. ⚠ A BOUND THAT WAS NEVER MIRRORED, FOUND BY WRITING THE MIRROR TEST

CLAUDE.md: „Server length bounds are mirrored as `maxlength` in the UI." §UC-PI-015's
table says 120 for „Meno a priezvisko *". `#pp-profile-name` had **no `maxlength`
attribute at all** — measured (`Received: ""`), not assumed, while phone/e-mail/Packeta
were all mirrored. The rule had a hole on the one field the table calls required, and it
had been there since the modal shipped. Added.

### 6. THE ENUMERATIONS IN §UC-PI-019 WERE WRONG AGAIN — ITEMS 10 AND 11, SIX AND SEVEN

Item 2 was stale, item 3 was stale by twenty files, item 9 under-counted; PI-T7, PI-T8
and PI-T9 each found another. This row found two more, and item 11's is the largest
relative error in the file:

| the item says | measured |
|---|---|
| „the FUP-T20 grep test (**424**)" | **467** — and it really did stay verbatim |
| „the display_name test (**494**)" | **538** — likewise |
| item 10 names ONE test in that describe | there are **TWO**, and the other one — the DOM copy sweep at 539 — reds on item 10's own rename, because its NON-VACUITY anchor is `toMatch(/užívateľské meno/i)` |
| „the **14** `'Bez e-mailu…'` help-text pins" | 14 OCCURRENCES, of which **1** is the friend help text (`:904`). **1** more (`:604`) is the ADMIN modal's different string („…sa **priateľovi** nedá poslať…") and **12** are the admin contact-cell BADGE. Rewriting fourteen would have deleted an admin surface's pins. |

⚠ The lesson is narrower than „re-count": item 10's figure was not just stale, it named
the WRONG MEMBER of a pair. „The FUP-T20 grep test stays verbatim" is true of the SOURCE
grep and false of the DOM sweep beside it, and only reading the describe shows that.

### 7. ⚠ `getByLabel` SUBSTRING MATCHING CUTS BOTH WAYS IN THE SAME EDIT

- „Mobil" → „Mobil *": `getByLabel('Mobil')` still matches, so nothing HAD to change.
  Changed anyway, for truthfulness.
- „Email" → „E-mail": `getByLabel('Email')` does **not** match „E-mail" (the hyphen is a
  character, not a separator), so every one of the eight sites HAD to change or red.
- „Užívateľské meno" → „Login": the rename is only observable INSIDE this dialog, because
  the string legitimately survives on the login screen (03 §UC-FL-002) and in BOTH
  username-setup dialogs in this same component. So the test pins the presence of „Login"
  AND the absence of „Užívateľské meno" scoped to the dialog — which doubles as proof that
  no setup label is rendered there to collide with it.

### 8. THE FIXTURE PHONE — PI-T9'S `ackExplainer` PROBLEM, SECOND EDITION

Same shape, different column. A friend created by `POST /api/friends` has no phone (right:
a brand-new friend genuinely has none), so every card-login fixture meets its own modal
over the drawer that `openProfile`/`openMenu`/`logout` reach for.

⚠ **The 76 TEMPLATE rows needed nothing**: every one already carries a phone (measured —
the scrub fakes them rather than nulling them). ⚠⚠ **But „the seeded circle is immune",
which is what this section said first, is WRONG and review caught it**: the template holds
NO `E2E*` row at all, and `seed.mjs` creates its own two friends — `E2ETester` (`:109`) and
`E2EExplainerGate` (`:128`) — with `{ name }` alone. `E2ETester` is explainer-pre-stamped,
so a legacy card login as that friend walks straight into the auto-open. Nothing is red
today (no spec in the gate does that and then needs the drawer), so this is a
RULE-ACCURACY defect, not a broken gate — and that is the worse kind, because the rule's
only job is to tell the next author where to look and it was pointing away from the two
friends they are most likely to reach for. The seed is deliberately NOT changed: it is a
shared input, nothing needs it today, and an accurate rule is the deliverable. The
containment is fixture constants: `FIXTURE_PHONE` (portal-profile-modal),
`makeFriendWithSession({phone = uniquePhone()})` (friends-consolidation) and
`GA_FIXTURE_PHONE` (google-auth, four creation sites).

`google-auth.spec.js` is the file this cost the most: its §UC-GA-006 and §UC-GA-007
describes are ALL „dismiss a modal and count what is left", so fourteen of them reddened
— each at a 2-minute actionability timeout, which is also why the first blast-radius run
was killed and re-run rather than watched to the end.

### 9. Smaller things measured rather than assumed

- **An unhydrated profile modal can no longer be saved at all.** With Mobil required and
  hydration stalled, „Uložiť" is disabled until the friend types a phone. FUP-T5's
  „an unhydrated modal must NOT wipe a stored Packeta address" test now says so out loud;
  its protected property (`packeta_address` ABSENT from the wire) is asserted as an
  absence rather than as an exact key set, because the typed phone legitimately travels.
- **The `.field-help` pin grew from two `nth()`s to the whole sequence + a count + an
  input-order pin.** An `nth(0)/nth(1)` pair cannot see a field that moved past it, which
  is the exact failure a reorder invites.
- **The `prihlasovac` guard caught my own COMMENT first.** The first draft of the new
  Login help's code comment contained the stem while explaining that the stem is
  forbidden. The guard greps the FILE, not the copy — comments included, which is what the
  FUP-T20 comment already said and what I still had to be reminded of by a red grep.
- **The friend's own „clear my contact data" API test had to split.** `{phone: null,
  email: null}` is now a 400; the property „clearing needs no confirm" survives on the
  field that is still optional, and the refused PATCH is read back to prove it wrote
  neither field.
- **The slow-hydrate race test got STRICTER, not weaker.** „B's fields are empty" became
  „B's fields hold B's OWN phone" — A's stale response landing would replace it either
  way, and the empty assertion was only ever a consequence of B having no contact data.

### 10. The mutation matrix (every one applied from a scratchpad copy, `cmp`-verified to have changed the file, rebuilt into `backend/public` or the backend restarted, run, then reverted)

| # | mutation | reddened |
|---|---|---|
| M1 | delete the `phone !== undefined && !phone` 400 | ✔ 2 of 3 (blank-phone refusal, whole-PATCH atomicity) |
| M2 | move the required-phone rule INTO `validateAdminFriendFields` | ✔ „the ADMIN PATCH may still clear a phone" |
| M3 | `MAX_PACKETA_ADDRESS_LENGTH` 160 → 1600 | ✔ the 160/161 bound test |
| M4 | drop FUP-T12's `typeof === 'string'` guard | ✔ „FUP-T12 survives" |
| M5 | drop `!profilePhone.trim()` from „Uložiť"'s `:disabled` | ✔ |
| M6 | drop the same term from `saveProfile()`'s JS guard | ✔ „a dispatched click … sends no request" |
| M7 | `profileAutoOpenArmed = ref(true)` (session-mount trigger) | ✔ „a RESTORE is not a login" |
| M8 | drop `!forcedPasswordChange.value` from the trigger | ✔ the forced-gate precedence test |
| M9 | `profilePhoneKnown` → plain truthiness of `props.friend` | ✔ „a friend WHO HAS a phone is never interrupted" |
| M10 | move the Packeta block back to its old position | ✔ the `.field-help` sequence + the input-order pin |
| M11 | rename the „Login" label back | ✔ the label test AND the `/prihlasovac/i` copy sweep |
| M12 | delete `maxlength="120"` from `#pp-profile-name` | ✔ the field-contract test |
| **M13** | **never lower `profileAutoOpenArmed` on open** | **✘ NOTHING — and that is correct, see below** |
| **M14** | **drop `!explainerGate.value` from the trigger** | **✘ NOTHING AT FIRST — a real gap; a test was written, and then it reddened** |
| **M15** | **drop `!showCredentialSetup.value`** | ✘ nothing at first, same gap, same fix; reddens the new test |

⚠ **M13 is defence in depth and I am saying so rather than claiming a test covers it.**
`watch` fires on a CHANGE of the watched expression, and closing the modal changes nothing
in it (`showProfileModal` is not a term), so „armed" staying true simply never fires again
in that session. It is kept because it states the intent and because it would matter the
day a gate term toggles late.

⚠⚠ **M14 AND M15 ARE THE REAL FINDING OF THIS MATRIX.** Two of the four precedence terms
reddened NOTHING when deleted — not because they are harmless, but because no fixture in
the suite was in the one state where the rules compete. For the explainer that state is a
FIRST login with no stored phone (`portal-explainer.spec.js`'s fixtures all carry a
phone); for credential-setup it is a transition-mode credential-less friend with no phone.
Two tests now build exactly those friends, and with them M14 and M15 both red. **A term
whose mutation is silent is not proven — it is unmeasured, and the fix is a fixture, not
a shrug.**

### 11. The gate, and the asked-versus-ran reconciliation

Targeted, per CLAUDE.md — but the row's blast radius made „targeted" mean 21 files, not 2.
`cd e2e`, `--workers=1`, output to a file, `DB_PATH` on both the seed and the run, all five
`RATE_LIMIT_*_MAX` at 100000, a fresh copy of `prod-template.sqlite` per run, the frontend
rebuilt into `backend/public` before every run.

**Asked 21 files, ran 21** (`grep -oE 'tests/[a-z0-9-]+\.spec\.js' … | sort -u`, reconciled
against the list): `portal-profile-modal`, `friends-consolidation`, `google-auth`,
`portal-appbar`, `portal-session-boundary`, `portal-explainer`, `portal-landing`,
`portal-menu`, `portal-shell`, `portal-balance`, `portal-history`, `modern-login`,
`magic-link`, `first-password`, `forced-change-ui`, `neo-control-metrics`,
`invitation-approval`, `admin-friends-labels`, `email-templates`, `nonstring-body-shape`,
`api-security`. **902 passed / 0 failed / 13 skipped, exit 0** (6.4 min). The 13 are the
documented `nonstring-body-shape` „no stack reaches the log" gates plus
`forced-change-ui`'s `test.fixme`.

⚠ **AFTER THE REVIEW ROUND (§12) the gate was re-run at 25 files** — the 21 above plus
`order-shell`, `order-pickup-edit`, `order-modals`, `order-cartbar`, added because the
minor-6 fix touches `FriendOrder.vue`'s checkout pickup modal. Asked 25, **ran 25**
(`diff` of the asked list against the ran list: empty). **998 passed / 0 failed / 13
skipped, exit 0** (6.5 min), on a FRESH template copy with the seed printing
`explainer: pre-stamped 77 friend(s); 1 left unacknowledged`. Server log: 16 lines, two
of them errors, both deliberate test cases (`api-security`'s CORS refusal,
`invitation-approval`'s CHECK-constraint probe). ⚠ The reviewer's own server was left
running on `:3997`; it was replaced rather than reused, because its DB was not a database
this row controlled and „the DB is an INPUT".

⚠ **The silent-drop trap fired once and was caught before the run**: `portal-vocabulary.spec.js`
is in §UC-PI-019 item 17's list but does not exist yet (PI-T11 writes it). Had it stayed in
a batch whose other entries matched, it would have been dropped without a word.

An earlier batch also measured the blast radius honestly rather than predicting it: run 1
of the card-login population reddened 14 `google-auth` tests at a 2-minute actionability
timeout each, and two files more (`portal-appbar`, `portal-session-boundary`) reddened for
a DIFFERENT reason — not the auto-open but „Uložiť" being disabled on a phone-less friend
under a `signIn()` RESTORE. ⚠ That second failure mode is worth naming: **a required field
reaches restore-based specs too**, even though the auto-open does not.

### 12. ⚠⚠ THE REVIEW: the precedence list was narrower than the class its own comment names

Two majors, four minors. The one that matters:

**The trigger enumerated four gates and the landing has SIX self-raising surfaces.** On a
CLOSED landing — the normal state for most of the month, not an edge — a phone-less friend
got `dialogs=2 modal-layers=2`, „Objednávky sú zatvorené" AND „Upraviť profil", scrim over
scrim. The reviewer found it by BUILDING that login (a phone-less credentialed friend,
`/api/friends/cycles` stubbed to one `completed` row, modern card login) rather than by
reading the list.

⚠ **The failure is not „I forgot two computeds". It is that I enumerated by SOURCE —
„the gates clarification (c) names, plus `showCredentialSetup`" — when the predicate is a
CLASS: „every surface that raises itself without the friend asking." `showClosedModal` /
`showLockedModal` are auto-raised `NeoModal`s from the same landing, and I had written the
class out longhand in the comment directly above the bug.** This is the standing
„a rule stated narrower than what it protects" trap, committed in the file whose comment
exists to catch it. The term list now carries all six with its own justification per term.

⚠ **ORDER: the state modal wins.** Clarification (c) says the auto-open runs AFTER the
other surfaces resolve, and the state modal is the landing explaining why there is nothing
to order; the profile form is the interruption. Every term is a `computed`/`ref` that
clears in place, so this is a QUEUE, not a race — the profile modal arrives the instant
the friend dismisses the state modal.

**M16–M19, the four mutations this fix owes** (each `cmp`-verified, rebuilt, run, reverted):

| # | mutation | reddened |
|---|---|---|
| M16 | remove BOTH state-modal terms (the shipped defect, restored) | ✔ `dialogs Expected 1, Received 2` — byte-identical to the reviewer's measurement |
| M17 | key on `landing.state !== 'closed'/'locked'` instead of the modals' visibility | ✔ the OTHER direction: the state never clears on dismissal, so the profile modal never arrives — „element(s) not found" |
| M18 | remove ONLY `!showClosedModal.value` | ✔ the closed test alone |
| M19 | remove ONLY `!showLockedModal.value` | ✔ the locked test alone |

⚠ M18/M19 exist because M16 removed both at once and could not tell them apart — the
same „a silent mutation is unmeasured" lesson as M14/M15, applied to my own fix before
anyone asked. The locked test is why `showLockedModal` is not a free rider.

**The four minors, each a documentation-or-mirror defect rather than a behaviour one:**

1. **03 §UC-FL-009 still described the pre-PI-T10 modal** — and its „⚠ OPEN" note, which
   disclaims INCOMPLETENESS, also vouched that *„everything the table DOES describe … is
   accurate"*. §UC-PI-015's own closing bullet points readers AT 03, where they read the
   opposite. ⚠ **A disclaimer about what is MISSING does not cover a later row CHANGING
   what is listed.** Three `~~strike~~`+pointer edits and the vouch itself struck.
2. **The FUP-T20 comment still said „the read-only `Užívateľské meno` box above"** eight
   lines above the box PI-T10 renamed to „Login". The grep guard sees a forbidden STEM,
   never a stale REFERENCE — so nothing could have caught it.
3. **„The seeded circle is immune" was false** — see §8, corrected in place.
4. **`FriendOrder.vue`'s checkout pickup modal is the 160 bound's SECOND client writer**
   and it had no `maxlength`. Worse than a missing mirror: `confirmPickupAndSubmit()`
   PATCHes the profile inside `catch { /* Non-critical, proceed */ }`, so a refusal has
   NO surface — „uložiť ako predvolenú" would just silently stop working above 160 chars,
   a regression this row's own bound would have introduced. Mirrored.
   ⚠ **RECORDED, NOT FIXED**: `orders.packeta_address` (`routes/orders.js:396`) is bounded
   on type + non-emptiness only, so the address that actually reaches the distribution
   sheet stays unbounded while the profile default is capped. Noted at the call site; a
   PI-T11 / guest-delivery decision.

⚠ And a fifth, which is this row's own lesson turned on itself: **my „re-measured" line
numbers (467/538/539) were stale by the time the diff landed** (actuals 518/596/542 —
my own +51/+58 lines moved them). Item 10's whole point is that an enumeration is a
measurement; a line number is a measurement with a shelf life of one commit. **The spec
now cites test NAMES.**

### 13. ⚠⚠ ROUND 2: A SEVENTH SURFACE, AND WHY I STOPPED MAINTAINING THE LIST BY HAND

Round 1 added the two landing state modals and I wrote the predicate as a CLASS above the
list. Round 2 found `showVoucherModal` — a seventh self-raising surface — under that same
comment. **Third consecutive copy of the same narrowing, and the second time under a
sentence that says „every surface that raises itself".**

The voucher is the worst one to have missed: `onMounted` AWAITS `checkPendingVouchers()`,
which raises a hand-rolled `fixed inset-0 z-50` teleport while `.modal-layer` is
`z-index: 200` — so the profile form paints OVER it. Measured, byte-identical to the
reviewer: `elementFromPoint()` over the voucher's own button returns **`INPUT.inp`**, my
e-mail field. The decision underneath is one-shot and irreversible („Toto rozhodnutie je
jednorazové a nedá sa zmeniť") and has no dismiss — only accept or decline.

⚠ The file's existing „ACCEPTED RESIDUAL — the voucher overlay" note did NOT transfer,
and checking that was the cheap part: its whole argument is that `googlePromptEligible`
is a SEEDED-ONCE ref and an async term would turn that seed into a `watch`. This trigger
*is* a watch. The cost that note was protecting against does not exist here.

**THE ACTUAL FIX IS NOT „MAKE IT SEVEN".** A hand-kept list under a class rule reads as
complete; that is what failed twice. So:

1. The comment now states the **derivation** — walk every overlay MOUNT (~~`<NeoModal>`,
   `<LandingStateModal>`, `<NeoDrawer>`, the teleported `fixed inset-0` div~~ — **a
   four-SHAPE list, and therefore a hand-kept list one level down: PI-T12 §4 replaced it
   with a shape-independent census**) and ask „can
   this raise with no friend action?" — and says *do not maintain the list by hand*.
2. `portal-profile-modal.spec.js` **pins that walk in source**: every mount must be
   either a trigger term or in a `NOT_SELF_RAISING` map WITH a reason. Proven by
   **M24**, which adds a brand-new `<NeoModal v-if="showFakeNewSurface">` and no term:
   the pin reds with `overlay mount(s) that are neither an auto-open trigger term nor a
   documented non-term: ["showFakeNewSurface"]` and tells the author what to do.
3. I re-derived the set MYSELF rather than accepting „seven": ~~nine~~ overlay mounts
   (**TEN — PI-T12's census found `<PaymentModal v-if="balancePayment" :open="showBalancePayment">`,
   a shape the walk's regex could not match; see PI-T12 §4**), of
   which `showInviteModal` and the drawer need a click, `showPasswordChange` /
   `showPasswordSet` are FOLDS inside the profile modal, `showBalancePayment` needs
   „Zaplatiť", and `showMagicPrompt` is a banner. Seven self-raising. It agreed — but
   the agreement is worth having only because it was checked.

**An eighth term of a different kind: `showProfileModal`.** Not self-raising — already
open. `openProfileModal()` unconditionally re-seeds all four fields, so a late hydrate
could wipe what the friend was typing: gates clear → hydrate still in flight
(`profilePhoneKnown` false) → friend opens Profil from the drawer and types → hydrate
lands → watch fires → fields reset. ⚠ The shipped „unhydrated modal" test cannot see it:
it uses `signIn()`, a RESTORE, so `freshLogin` is false and the trigger never arms.

**Round-2 mutation matrix:**

| # | mutation | reddened |
|---|---|---|
| M20 | remove `!showVoucherModal.value` | ✔ BOTH the source pin (naming `showVoucherModal`) and the behaviour test — `elementFromPoint` returned `INPUT.inp` |
| M21 | key on `!pendingVouchers.value.length` | ✘ **nothing — and it is not a discriminating mutation**: `resolveVoucher()` filters that array, so the term does clear. Discarded rather than reported as a pass. |
| M22 | disarm on raise („skip the profile prompt this session") | ✔ the QUEUE half — the profile modal never arrives after the friend answers |
| M23 | remove `!showProfileModal.value` | ✔ the typed name came back as the server's — „… TYPED" wiped |
| M24 | add an eighth overlay with no term | ✔ the source pin, by construction |

⚠ **M21 is recorded because it is the honest shape of a failed probe.** The first
direction-2 attempt did not discriminate, and the reason (the array really is filtered)
is more useful than quietly swapping in one that works. The replacement, M22, is also
the more realistic wrong implementation.

⚠ **The voucher fixture failed on its first run and the failure looked like success.**
A thin stub (`{id, amount}`) makes the overlay's own render throw on
`voucher_amount.toFixed(2)`, so the overlay never appears — which is exactly what „the
fix works" looks like. The stub carries the full shape now, and the comment says why.

⚠ **Assertion ORDER inside the voucher test is deliberate.** A dialog COUNT reds under
M20 too, but it reds *before* the `elementFromPoint` line runs — so the z-order claim
would have been carried by a cheaper assertion and never measured. The discriminating
assertion goes first; the counts follow.

**Round-2 gate:** the same 25 files, asked 25 / **ran 25** (`diff` empty), **1001 passed
/ 0 failed / 13 skipped, exit 0** (6.5 min) on a fresh template copy with the seed
printing `explainer: pre-stamped 77 friend(s); 1 left unacknowledged`. Server log: 16
lines, two errors, both deliberate test cases. The PI-T10 auto-open describe is now
**13 tests** (10 behaviour + the source pin + the voucher + the re-prefill).

**Round-2 documentation fixes:** a FOURTH falsified claim in 03 §UC-FL-009 (the „no
helper text under the read-only row" bullet — ⚠ it lived in PROSE below the table, and
my first sweep walked the TABLE and stopped: **grep the section, not the structure you
expect**); and item 11's paragraph, which added three fresh raw line numbers — two
already wrong — *three lines after item 10 records „cite test NAMES"*. ⚠ **A lesson
written down is not a lesson applied.** Both now cite test names.

### What PI-T10 LEAVES BEHIND

1. ⚠⚠ **The auto-open's trigger is a LOGIN, not a session mount, and that DEPARTS from the
   row's own note** (§1). If it is overturned, the change is one seed and ~37 fixture
   phones. Both halves are pinned, so an overturn reds a named test rather than drifting.
2. ⚠ **PI-T9's `LEAVES BEHIND` item 4 is DISCHARGED**: the chain is now four deep
   (forced-password → credential-setup → Google prompt → explainer → profile), and the
   fourth link is CODED, not structural — the reason is §2 above, not forgetfulness.
3. ⚠⚠ **THE TRIGGER'S TERM LIST IS DERIVED, NOT MAINTAINED BY HAND — and a source pin
   enforces that.** Clarification (c) names three gates; the trigger has **eight** terms
   (seven self-raising surfaces + `showProfileModal`), and the list was wrong in review
   TWICE (§12, §13). `portal-profile-modal.spec.js` now walks every overlay MOUNT in the
   component and fails on any that is neither a trigger term nor a documented non-term,
   so an EIGHTH self-raising overlay reds instead of stacking. **Add the mount and let
   the pin tell you** — do not edit the list from memory.
4. **The module-21 slot is a MARKED COMMENT directly under Mobil** in
   `FriendPortalSession.vue` — `whatsapp_opt_in`'s `NeoCheckbox` goes there (WA-T1), and
   the `.field-help` ORDER pin in `portal-profile-modal.spec.js` will red if a field is
   inserted without its help. The checkbox is not a `.field-help`, so WA-T1 should expect
   that count to stay 5 unless it adds a help line of its own.
5. ⚠ **A fixture friend that CARD-LOGS IN needs a `phone`** (§8), the same way it needs
   `ackExplainer()`. Three constants carry it today; a new card-login spec needs its own.
6. **`friends.packeta_address` still has exactly ONE writer**, and the 160 lives with it
   (§4). A second writer means moving the bound, not copying it.

## PI-T11 — the vocabulary rule, its guard, and the deep-link net (2026-09-23)

18 §UC-PI-017 / §UC-PI-018. The work was done over two sessions. The first was interrupted
before it could run its own gate. The second session audited that work against the
edit table, finished it and gated it.

### 1. ONE home for the ban: `e2e/helpers/vocabulary.js`
When this task started, the ban existed in three spellings and no two of them banned the
same words: the shipped `cycle-stages.spec.js` `/\bkol[oáa]|cykl/iu`, 17 §UC-CS-009
`/kol[oáa]\b|cykl/i` and 18 §UC-PI-017 `/cykl|\bkol(o|a|e|u|om|á|ách)\b/i`. JS `\b` is
ASCII-only, so both spec spellings miss „kolá", 17's also flags „okolo", and the shipped
one misses „kole"/„kolu". `BANNED` is now the union, built with an explicit Slovak
letter class in place of `\b`. It is NOT `/g`. `BANNED_CASES` is its proof table.
`cycle-stages.spec.js` imports it and no longer keeps its own copy.
⚠ The first cut's union still missed three plural forms, „kolám", „kolami" and „kôl". The
review found them, and `BANNED` now covers all ten forms. `BANNED_CASES.bad` names the full
paradigm and `portal-vocabulary` §1 pins it by IDENTITY, because a length gate had passed
without those three. Every superseded copy of the old regex is struck with a pointer:
CLAUDE.md, 17 §UC-CS-009, 18 §UC-PI-017, learnings 01/09 and PROGRESS. In PROGRESS that
means the CS-T2 log entry (:1023) and this task's own PI-T11 row (:438). Round 1 of the
review missed the row: its regex and its „Node grep guard" / „guard file list widens"
wording were struck only in round 2. The copies still left are HISTORICAL records that
name the old spellings in order to explain them: the `vocabulary.js` header, the
„three spellings" test and the `cycle-stages.spec.js` comments.

### 2. The source guard's file set is DERIVED, not typed
`importClosure(FRIEND_SURFACE_ROOTS)` walks the imports reachable from `views/FriendPortal.vue`
and `views/FriendOrder.vue`, then sweeps each file with its comments stripped
(`source-pins.js stripComments`, the one strip). The spec's hand list was checked against
this set:
- The derived set contains every file on the hand list except `PickupLocationPicker.vue`.
  That file is ADMIN-only and the spec listed it by mistake. The spec pins its absence.
- The derived set also covers at least 15 files the list never named, e.g. `DebtBanner`,
  `PortalExplainer`, `history-badges` and `api.js`.

⚠ Run as written, the spec's literal `grep` still returns hits. They are lines inside
multi-line `<!-- … -->` comments, which the grep's trailing `-vE` filter cannot recognise.
The Node guard is the authoritative form. ~~GL-T7 widens it by adding the two guest roots
to `FRIEND_SURFACE_ROOTS`.~~ **GL-T7 widened it with a SEPARATE `GUEST_SURFACE_ROOTS` list (pinned equal
to the router's `/g/…` components) and sweeps `VOCABULARY_ROOTS` = the union — a guest view in a list
named FRIEND would have been read as friend surface by §2's pins (learnings 11 §GL-T7).**

### 3. Server messages — audience-scoped
Only messages that reach a FRIEND were re-worded. Every status code was kept.
- `orders.js validateCyclePassword` 404 → „Ponuka nebola nájdená". This helper serves the
  deep link's GET, the cart PUT and the submit, and `FriendOrder` paints the message
  verbatim.
- The two host `guest-links.js` routes → the same 404 text.
- The Packeta 400 → „Doručenie Packetou nie je pre túto objednávku dostupné", worded
  exactly like module 20's guest twin (20 §5).
- The voucher-accept ledger note → „Voucher za objednávku {name}". It renders on
  `/zostatok`. Old stored rows keep their old text.

The copies that stay are all admin-guarded: the orders pickup PATCH, the three admin
`guest-links` routes, `vouchers /generate` and `/cycle/:id/friends`, the `products.js`
duplicate 409 and all of `cycles.js`. `cycles.js /:id/public` and `/:id/auth` are
friend-shaped, but no frontend code calls them (`getCyclePublic`/`authenticateCycle`
have no caller), so they were left alone. `guest.js`/`guest-orders.js` → GL/GP rows.
⚠ **Handed to GL-T7, named rather than kept quietly (review):** `guest-orders.js:197`/`:238`
are the host's `DELETE /api/guest-orders/:id` 409s („Cyklus je už uzavretý / bol práve
uzavretý, objednávku kolegu už nie je možné odstrániť."). They DO reach a friend:
`GuestSubOrders.vue removeSubOrder()` → `error.value = e.message` → the `.banner.danger.slim`
at `GuestSubOrders.vue:378-380` on the Kolegovia tab. `:525`/`:562` („…zrušiť.") are on
`POST /:id/cancel`, which is `requireAdmin` and called only by `CycleDetail.vue`, so they
may keep „cyklus". All four are named in the GL-T7 row and in 18 §UC-PI-017's hand-off
list. The DOM sweep does not see the two host 409s: no fixture drives a refused removal.
**→ DECIDED by GL-T7: the host pair re-worded („Objednávky sú už / boli práve uzavreté, …odstrániť."),
the admin pair kept; both pinned in source AND live in `portal-vocabulary.spec.js` §6 (learnings 11 §GL-T7).**

### 4. The DOM sweep, and `data-user-copy`
`portal-vocabulary.spec.js` imports `helpers/copy-sweep.js` and has no copy of its own.
The marked renders are listed below. After two review rounds they are every
person-typed render found on the surfaces the sweep visits; ✓ means a POISONED fixture
proves the mark:
- cycle name:
  - BrandChrome `.t` on the deep link ✓;
  - the locked landing caption „Ponuka · …" ✓ and the closed one „Minulá ponuka · …"
    (not poisoned: the closed stubs use neutral names);
  - history rows ✓ (`PI11b kolo cyklus`);
  - the voucher modal ✓;
  - the share-dialog subtitle ✓;
  - the drawer's „Moje objednávky" sub-line ✓.
- BrandChrome `.s`, the friend name: not poisoned.
- product name, description, composition, category and `alt`, and the `CartLineList`
  name and purpose: not poisoned. Fixture product names are neutral.
- the drawer friend name and the tx note: not poisoned.
- pickup location name and address:
  - in the pickup modal ✓ (the app-copy „Iné" stays readable, mutation-checked);
  - on „Ako to funguje" ✓. `PortalExplainer.pickupParts` replaced a joined string; the
    rendered text is byte-identical;
- the own-order pickup badge ✓. `FriendOrder.orderPickupText` now returns
  `{ text, data }`, so „Packeta · " stays app copy.
- a colleague's `guest_name` ✓ (the live card; the cancelled-card twin at
  `GuestSubOrders.vue:448` is marked but not driven).
- `plan_note`, in all five places it renders:
  - `landing-next-round` ✓;
  - `landing-closed-banner` ✓ and `landing-locked-banner` ✓;
  - the closed ✓ and locked ✓ state-modal card.

Every ✓ is `expectExcluded()`: the value rendered, is marked, and the app sweep does not
see it. Each ✓ added in review was mutation-checked by unmarking it, and each went red.

The shapes behind the marks:
- The history sub-line is `{ text, data }` → NeoDrawer's `sub` + `subData`, with ONE
  render.
- The plan-note decision has one home, `lib/portal-state.js nextTextIsNote()`.

⚠ This is NOT a claim that every friend-facing render in the whole app is marked. The
unpoisoned rows above are marked but unproved. A new surface joins the sweep, and its
data joins the markers, together. §4.5 is the original exclusion proof, on the locked
landing's caption.
⚠ The sweep's `mustSay` gate is POLLED: `expect.poll`, then the ban runs on that same
snapshot. One run went red when the deep link's appbar title painted before
`FriendOrder` finished loading and the sweep read „Načítavam...". So the gate is also
the „screen is ready" wait.

### 5. The gate
Targeted, `--workers=1`, fresh DB, all five limiters at 100000, idle box.
- A 23-file batch: **888 passed**, 0 skipped. The files that ran match the files asked
  for.
- `portal-vocabulary`: 20 passed, 3 runs in a row after the poll fix.
- A final run of `portal-vocabulary` + `order-shell` + `cycle-stages`: 158 passed.
- Review round 1 re-gate, a 22-file batch: **648 passed**, 0 skipped. The files that
  ran match the files asked for.
- Review round 2 re-gate, fresh DB, **171 passed**:

  | File | Passed |
  |---|---|
  | portal-vocabulary | 26 |
  | portal-landing | 43 |
  | portal-menu | 28 |
  | portal-history | 15 |
  | order-locked | 9 |
  | order-shell | 14 |
  | portal-explainer | 36 |

  ⚠ A naive `grep -oE 'tests/…spec.js' | uniq -c` counts portal-explainer as **37**. The
  extra hit is the reporter's stderr header for a `node:sqlite` ExperimentalWarning,
  which repeats the test title, not a second run. `--list` says 36. Reconcile a count
  against `--list` before believing it.

### 6. Mutations
Each mutation was applied, confirmed changed with `cmp`, rebuilt or the server
restarted, run, then reverted:
- (first pass, before the review fixes) „Späť na zoznam cyklov" in the source → the source guard reds.
- „Späť na ponuku cyklov" in the build → the fatal-error DOM sweep reds on the ban.
- `data-user-copy` dropped from BrandChrome's `.t` → the poisoned deep-link sweep reds.
- The orders 404 reverted to „Cyklus nebol najdeny" → §3 and the fatal-error banner red
  (2 tests).
- `collectAppCopy` returning '' → 9 of 10 DOM/deep-link tests red on the non-vacuity gate.
- Review round 1 — unmarking each of these went red:
  - NeoDrawer `subData`;
  - the LandingStateModal note;
  - the closed-banner note;
  - GuestSubOrders `guest_name`;
  - the GuestShareDialog name;
  - the pickup-modal name.

  Two more reds: marking „Iné" unconditionally (the screen-read gate), and `BANNED`
  without `ami|ám` („the ban catches „kolám"").
- Review round 2 — unmarking each of these went red, and each failure's offender line
  names the poisoned value:
  - the `landing-locked-banner` note;
  - the `landing-next-round` note;
  - the own-order pickup `data`;
  - the explainer location name.

## PI-T12 — the module-18 closeout: the canon, not `normal`; a drawer walk; a derived admin surface; and three pins that measured less than they claimed (2026-09-23)

18 §UC-PI-019 items 13, 14 and 18, its Procedure, and the PI-T10 review's term-count ask.
Tests are the product of this row. It changed app code in four files, and each change
answers a pin that was first seen red.

### 1. ⚠⚠ Item 13: two of the four named sites are not A10 sites, and measuring the canon found three drifts

A10 covers only the classes the canon leaves line-height-SILENT. Item 13 named four
landing sites „at `line-height:normal`". The canon declares a value for two of them:

| element | canon | shipped | now |
|---|---|---|---|
| `.banner.slim` (status, closed, locked, next-round, debt) | silent ⇒ A10 `normal` | `normal` | pinned |
| `.badge` (own-order card ×3 + `CartLineList` group header, catalogue cards) | silent ⇒ `normal` | `normal` | pinned |
| own-order `.display` ×2 | inline `lineHeight: 1` (`portal2.jsx:350/356`) | inline **`.9`** (19.8px) | **fixed → `1`** (22px) |
| `.cs-tl .lbl` / `.now .lbl` | `1.25` / `1` (`portal2.css:31/33`) | ported | pinned 18.75px / 20px |
| `.cs-tl .when` (NOT named by item 13) | silent ⇒ `normal` (`portal2.css:34`) | **17.25px** (preflight's 1.5) | **fixed** (`CycleTimeline.vue` scoped) |
| state modal's 38px date | inline `.9` (`portal2.jsx:417`) | `.9` | pinned 34.2px |
| history round name | inline `1` (`portal2.jsx:207`) | `1` | pinned |
| history total | `fontSize: 18` only (`:211`) ⇒ A10 `normal` | inline **`.9`** (16.2px) | **fixed → removed** |
| balance card figure | inline `1` (`:232`) | `1` | pinned 38px |

⚠ Pinning the two declared sites at `normal`, as written, would have pinned a DRIFT and
called it fidelity. The own-order `.9` is `LandingStateModal`'s 38px date value copied to
a different element, and its comment even said „the canon's value". **A comment that
cites the canon is not a measurement of it.** The last four rows are the PI-T4, PI-T6 and
PI-T7 hand-offs, which asked for them by name.

`CycleTimeline.vue`'s header now counts FOUR deviations from the canon's bytes. The
fourth, `.when { line-height: normal }`, restores the canon's RESULT: the prototype
gets `normal` for free, because it has no Tailwind. `.mk` is left alone on A10's
`.tabbadge` reasoning (a fixed 28px flex box centres its line). The admin header mounts
only the COMPACT variant, which has no text, so no admin pixel moved.

### 2. ⚠⚠ The 320px pass found two real overflows, and my own layer check was vacuous for one of them

**The state modal's footer overflowed with NO hostile text.** „Ako to funguje" +
„Prezrieť ponuku" are `nowrap` + `flex:1` and need ~290px of min-content. A 320px
viewport leaves 240 (scrim 18 + border 4 + `.m-foot` 18, a side, minus the 8px gap).
Result: scrim 330 > 320, and so on every viewport below ~370px, on the CLOSED landing,
which is the app's normal state for most of the month.
- Fixed with a wrapping row (`LandingStateModal.vue .lsm-actions`, `flex-wrap`).
- NOT the Google prompt's column. At the canon's 378px the row fits and stays the canon's
  two equal 145px buttons. Measured: 320 and 360 wrap to 240/280-wide rows; 378 and 420
  stay one row.
- Padding relief (`FriendOrder.vue .fo-foot-btn`) saves only 24px, so it was not enough.
- Pinned in BOTH directions: the scrim test reds on overflow, and „one row at 378px" reds
  on a permanent column (F5).

**The drawer scrolled sideways, and the first version of my helper could not see it.**
`noLayerOverflow()` measured the scrim and the `.p2-drawer` box, and both reported a clean
271/271. The drawer's row list is its own `overflow-y:auto` column, so `overflow-x`
computes to `auto` there too, and that list absorbed the spill. This is PI-T7's scrim
lesson, one element further in. A probe found it (1016 > 271: the „naposledy {cycle name}"
sub-line). With a hostile friend NAME the header then pushed the scrim itself to 1194 > 320.
- Fixed: `overflow-wrap: anywhere` on both of `NeoDrawer.vue`'s text columns.
  `min-width:0` was already there, and CLAUDE.md says in so many words that it is not a
  wrapping rule.
- The helper now measures every DESCENDANT. None may be a sideways scroller, and none may
  paint past the box, unless an ancestor inside the box clips it (the copy row's ellipsis
  is the legitimate case).
- The profile and invite 320px tests only ever measured the DOCUMENT, which PI-T7 showed
  measures nothing while a dialog is up. They now run the layer check too, and it passes
  on both.

⚠ **Rule, recorded in CLAUDE.md:** a 320px claim about a modal-layer surface measures the
layer and every descendant scroller, never only the document or the outer box.

### 3. Item 14: the drawer walk, and why „the explainer incl. the checkbox" is two stops

`walkAuthenticated()` now goes through the drawer, stop by stop:
1. the drawer itself (its header is the one place a friend's NAME renders);
2. history, with its one round EXPANDED;
3. „Zostatok a platby" and its Platba modal;
4. „Ako to funguje";
5. Profil, with the password fold;
6. „Pozvať priateľa";
7. „Zdieľať s kolegami", when the round is open.

The four invariants are unchanged.
- **The checkbox renders only on the first-login GATE** (`asGate`), never on the drawer's
  explainer. So the modern test's two friends are created with `ack: false` and the walk
  starts on the gate. A unticks the pre-ticked box, and B must meet it ticked again: an
  unticked box carried across the boundary would silently skip B's acknowledgement
  write. That is `aria-checked`, which invariant 4 (`aria-pressed`) cannot see, so it is
  asserted by name. The drawer's explainer stop pins the box's ABSENCE.
- **The data is stubbed, never written.** The file's rule is „nothing global is mutated".
  `GET /friends/cycles` is the REAL list plus one completed `hasOrder` row
  (`route.fetch()`), so the landing keeps the database's state. That row's line fetch
  answers PER FRIEND, `History line for #<id>#`, so a lines cache that survived the logout
  paints A's line on B's screen. The balance is a stubbed debt with a `payment` block,
  and (review) it is PER FRIEND too: amount `500 + id + .37`, reference `… #<id>#`, VS
  `8<id>`. A's three values join the secret sweep, and the Platba modal must quote the
  walking friend's own VS. The first version answered identically for A and B, so a
  balance cache that survived the logout was invisible by construction (B1).
- **The walk's own non-vacuity:** the modern test pins the exact list of 12 snapshot
  labels. „Share" is the one conditional stop, and the gate DB always has `seed.mjs`'s
  open round, so a missing `B:share` is a lost stop (S4).
- **And its own COVERAGE:** at the drawer stop the walk reads every `[data-menu-item]` key
  and reds on one it does not visit (`WALKED_ROWS`). A new drawer row therefore cannot
  land without its own stop here (S5). The first draft of the header only said that
  `portal-menu` would notice, which is true but tells nobody to come here.

Mutations, each rebuilt, run and then restored `cmp`-identical:

| # | mutation (a real leak class: a plain-`<script>` singleton) | reddened |
|---|---|---|
| S1 | `PortalExplainer` `hide` shared across mounts | ✔ „B: the gate's checkbox arrives pre-ticked" — `false` |
| S2 | `expandedRound` shared across sessions | ✔ both walk tests — „B: no round is expanded on arrival" |
| S3 | `roundLines` shared across sessions | ✔ both — B's round painted `#125#` where `#126#` was due |
| S4 | the share drawer row removed | ✔ the label list — `B:share` missing |
| S5 | an eighth drawer row (`extra`) added | ✔ both walk tests — „a drawer row this walk does not visit" |
| B1 | `balance`/`balancePayment` module-scoped + „skip the fetch if cached" (a tab-lived balance cache) | ✔ both walk tests — B's Platba modal quoted `8000091`, A's VS |
| S1+S2+S3 | all three at once, run against **HEAD's** spec | ✘ **HEAD: 3 passed** — the old walk was blind to all three; the new one reds 2 |

### 4. ⚠⚠ The trigger TERM COUNT pin: the existing pin was count-less, spelling-bound, and its walk missed a mount

The PI-T10 review asked for a source pin over `FriendPortalSession.vue`'s auto-open trigger
TERM COUNT: „pin the COUNT, not the spelling". CLAUDE.md said
`portal-profile-modal.spec.js` already „PINS THE WALK IN SOURCE". I checked it against
that ask before touching it. It fell short in three ways:
1. **No count.** `mounts >= 9` and `terms >= 8` are floors. A ninth term went green (T1).
2. **Spelling.** The „other direction" was a list of seven NAMES. A harmless consistent
   rename went red (T5), and a new term said nothing.
3. **⚠ The walk was narrower than its own rule** — the class of defect it exists to catch,
   one level down. It found mounts by SHAPE: `<NeoModal|LandingStateModal|NeoDrawer
   v-if>`, plus `<div v-if … class="fixed inset-0">` in exactly that attribute order. A
   shape-independent census of the template finds **TEN** overlay mounts, not nine.
   `<PaymentModal v-if="balancePayment" :open="showBalancePayment">` matched neither
   shape: it is the one overlay whose visibility is a PROP. Its comment called it a
   non-term, but the pin had never looked at it. A new overlay written that way, or as a
   class-first fixed div, went green (T2, T3).

What replaced it (the same two test names' neighbourhood, and one new test):
- a CENSUS: every `*Modal`/`*Dialog`/`*Drawer`/`*Sheet`/`*Popover` component and every
  element with a `fixed` class TOKEN or inline `position:fixed`. Visibility is read from
  `:open` / `v-model:open` / `v-show` first and `v-if` last, because PaymentModal's `v-if`
  gates on DATA. Every `<Teleport>` must wrap a census hit.
- ⚠ **Review round, three holes in the census itself.**
  - It stripped the TEMPLATE with `stripComments()`, i.e. JavaScript rules, which a Vue
    template does not have. A `/*` in text and a `*/` later would swallow the mount between
    them. Now only `<!-- -->` is stripped, and an ORDERED list of `GATE_TOKENS` must survive,
    with at least one token between every pair of consecutive mounts.
  - The attribute scan `[^>]*` stopped at the first `>`, so
    `<div @click="() => x" class="fixed inset-0" v-if="y">` was never counted. The scan is
    now quote-aware.
  - Writing the direct fixture test for those two found a THIRD: `\bfixed\b` matched
    `class="not-fixed-here"`, because `-` is a word boundary. It is now a whole-token match.
    `scanOverlays()` is a pure function, and the fixture test (arrow-in-attribute,
    `v-model:open`, `>` inside a quoted attribute, inline `position:fixed`, an HTML-commented
    mount, a JS-comment „hole") pins every shape; it also proves the JS strip WOULD have lost
    the drawer.
  - The count test's failure message names the three prose copies of „10 / 8": CLAUDE.md,
    the trigger comment and this section.
- `showBalancePayment` joins `NOT_SELF_RAISING` with its reason. A stale exclusion reds.
- `NON_MOUNT_TERMS = { explainerGate }`, with its reason. That is the reverse direction: a
  term with no surface behind it cannot hide either.
- **The count, derived AND pinned.** The trigger's terms must EQUAL (mounts −
  click-only) ∪ non-mount terms, with no duplicates and no click-only surface as a term.
  The numbers are then pinned as numbers (10 mounts, 8 terms), so a diff has to change
  them on purpose. That is what reds T6, where a new overlay arrives WITH its term and
  every set check passes.

Mutations, each applied to both the working tree and HEAD's copy, then restored
`cmp`-identical:

| # | mutation | NEW | HEAD |
|---|---|---|---|
| T1 | `&& !showInviteModal.value` added (a click-only 9th term) | ✔ red | ✘ green |
| T2 | `<PaymentModal v-if="balancePayment" :open="showAutoPromo" />`, no term | ✔ red ×2 | ✘ green |
| T3 | a teleported `<div class="fixed inset-0" v-if="showPromo">`, no term | ✔ red ×2 | ✘ green |
| T4 | `&& !explainerGate.value` deleted | ✔ red | ✔ red |
| T5 | `showVoucherModal` → `voucherOverlayOpen`, file-wide (behaviour unchanged) | **green** | ✘ red |
| T6 | T2's overlay AND its term, together | ✔ red — the mount COUNT alone | ✘ green |

T5 is the „count, not spelling" half, shown by measurement.

⚠ The derivation text had three copies that named the four shapes. All three now carry a
strike and a pointer: the trigger comment in `FriendPortalSession.vue`, CLAUDE.md, and
PI-T10 §13 of this file.

### 5. Item 18: admin invariance over a DERIVED admin surface

The existing pin (`portal-shell.spec.js`, „no ADMIN view imports the three module-18
libs") read a TYPED list of six views, and its regex named two of the three libs. It never
read `LiveCycleDashboard`, the analytics views or `AdminCatalog`, and a TRANSITIVE import
was invisible by construction (A1: green on HEAD).

Now the roots are every `/admin…` route component in `router.js` (16 of them), parsed PER
ROUTE, from its `path:` to the next one, so a `meta: {…}` / `props: {…}` before `component`
cannot hide one. The component is read lazy (`() => import('./…')`) or static (an imported
identifier), and the result is reconciled EXACTLY against the raw count of
`path: '/admin` occurrences (review: it was a `>= 16` floor over one regex whose `[^}]*?`
stopped at the first `}`). The surface is their `importClosure()`: 86 files, the shared
components, `CycleTimeline.vue` and `BalanceBadge.vue` included. Four pins sit over it:
1. No `lib/roasters|dates|portal-state.js` is reachable from it.
2. No `components/neo/` file is reachable, and no friend-portal view either.
3. No template class token is a `pp-*` utility, a `p2-*` class or a class from the
   DERIVED theme vocabulary. Harvested: every static `class="…"`, plus the object KEYS of
   every `:class`, quoted AND unquoted (review: the first version read quoted keys only; the
   unquoted harvest reads `CycleTimeline`'s `{ now, next }` today and is gated on doing so).
   NOT harvested, deliberately: string literals in `:class` ternaries/arrays, which cannot
   be told apart from comparison operands (`dir === 'flat'` measured as a false `flat` in
   `CoffeeAnalytics.vue`). The DOM pins in `catalog-admin`/`portal-balance` remain the net
   for a runtime-chosen class. Four collisions
   are documented with reasons: `grid`/`block` are Tailwind utilities; `ln`/`lbl` are
   `CycleTimeline`'s own scoped classes. A positive control, the same harvest over the
   friend closure, finds hundreds.
4. `friends-theme.css` has no unprefixed selector, UC-DS-014 item 2's second half, which
   was pinned nowhere. Only `@keyframes` steps and the A6 roots are exempt.

`BalanceBadge.vue` „untouched" stays `portal-balance.spec.js` §7's `git diff main` pin.
Result: **no violation today.** A1–A5 are the proof that each pin can fail:
- A1: a transitive `lib/dates.js` import in `MarginChart.vue` → red (HEAD green);
- A2: `class="banner"` in `LiveCycleDashboard` → red;
- A3: `hover:text-pp-ink` → red;
- A4: a `NeoIcon` import in `AdminFriends` → red;
- A5: an unscoped `.badge{}` rule → red.

### 6. The retired-file property audit

Module 18 retired three spec files and one component:
- `portal-cycles.spec.js` and `portal-share-row.spec.js`, both PI-T3;
- `portal-transactions-modal.spec.js`, PI-T7, renamed to `portal-balance`;
- `FriendTransactionsModal.vue`, PI-T7, which became `FriendTransactionList.vue`.

Every row that PI-T3 §1 and PI-T7 §3 mark SURVIVES, KEPT or RETARGETED was checked against
today's suite by TEST NAME. Each has a live test of the kind named:
- the item-4 sub-line ×4, the ONE-request bound, logout and deferred-response drops →
  `portal-menu` „PI-T3 · … the colleague count";
- the share entry, no affordance off-open, failed count gates nothing → `portal-landing`
  „two entry points, ONE dialog";
- the gear's absence → `portal-subscription-invite`;
- the landing's empty copy → `portal-landing` „Ponuka ešte nie je pripravená.";
- the archive fold → `portal-history` + `portal-landing` „no archive fold";
- PI-T7's rows, all 23 → `portal-balance`, including „`FriendTransactionsModal.vue` is
  gone, and nothing imports it".

Two findings:
- ⚠ **PI-T3 §2's one homeless property is STILL homeless.** It is the count response
  deferred past a second in-session `loadCycles`. `cycles` still has no in-session
  reloader (`loadCycles()` stays deleted), so the kept `guestCountSeq` guard stays
  unreachable.
- ✔ **One property the PI-T3 table marked „retires" now has a home again.** The archive
  fold's „does not survive a logout into the NEXT session" is §3's history stop (S2/S3).

### 7. Edited e2e files: **4**

`portal-fidelity` 9 → 19, `portal-shell` 29 → 32, `portal-profile-modal` 51 → ~~52~~ **53**
(the review added the census fixture test), and `portal-session-boundary` 3 → 3 (the walk
was rewritten). **2312 → ~~2326~~ 2327 tests, 92 → 92 files.** The counts were measured with `--list` against a `git archive HEAD` copy, per
file.

### 7b. The review round: five minors, and what each mutation proved

App code was untouched in this round, so there was no full-suite re-run (the coordinator's
call). Every mutation was applied from a scratchpad backup, `cmp`-verified, and restored
`cmp`-identical. B1 was rebuilt and a clean build was restored afterwards.

| # | mutation | new pin | the pre-review version |
|---|---|---|---|
| T7b | `<div @click="() => noop()" class="fixed inset-0 z-50" v-if="showArrowPromo">`, no term | ✔ red — „neither a trigger term nor a documented non-term: [showArrowPromo]" | ✘ `[^>]*` saw only ` @click="() =`, measured |
| T7 | the same div flush against the profile modal | ✔ red — on the GATE's interleave rule („no token between … add one to GATE_TOKENS"), which runs first | — |
| G1 | the drawer mount wrapped in `<!-- … -->` | ✔ red — gate: „`onMenuSelect` must survive" | — |
| R1 | an admin route with `meta: {…}` BEFORE `component`, pointing at `FriendOrder.vue` | ✔ red ×3 — roasters/neo/theme classes reachable from admin | ✘ old regex: 16 roots, the new one absent, floor passes |
| R2 | the same through a STATIC `component: AdminX` import | ✔ red ×3 | ✘ same |
| A6 | `:class="{ banner: true }"` in `AdminVouchers.vue` | ✔ red — „`banner` is a friends-theme class" | ✘ the quoted-only harvest never saw it |
| B1 | the tab-lived balance cache (§3) | ✔ red ×2 | ✘ identical-per-friend stub — blind by construction |

⚠ The T7 row is a property, not a flaw: a new mount placed with no token between it and
its neighbour reds on the GATE first. So an author meets „add one to GATE_TOKENS" before
„classify it", and both fire in turn. T7b places the same shape between tokens to show the
classification half on its own.

### 8. The gate

- `node --check`: no backend file changed. `npx playwright test --list`: **2326 tests in
  92 files**.
- Build: `frontend` → `backend/public`. Server: fresh template copy per run, seed with
  `DB_PATH` (printed `explainer: pre-stamped 77 friend(s); 1 left unacknowledged`), all
  five limiters at 100000, `--workers=1`. Box: 8-core, load 0.5–0.9 at each start, no
  stray playwright or wait-loop processes.
- **Targeted: 22 files asked, 22 ran** (`diff` empty). **827 passed / 0 failed / 0
  skipped, 6.6 min.** The files: the six module-18 specs, items 4–16's files,
  `cycle-stages` + `guest-status-shell` (the timeline), `order-locked` and `share-dialog`.
  Server log: one CORS refusal, `api-security`'s own. The `WALKED_ROWS` coverage check
  landed after that batch collected, so it was re-run alone: 3/3.
- **FULL SUITE: 2322 passed / 0 failed / 4 skipped, 13.2 min, exit 0. 92 files listed,
  92 ran.** The four skips are the documented ones: `forced-change-ui`'s `test.fixme`,
  `magic-link-rate-limit`, `rate-limit-isolation`, `rate-limit`.
  - ⚠ 13.2 min is between the idle ~12 and the loaded ~14. Load rose from 0.89 to 2.13
    during the run, and nothing went red.
  - Server log: 306 lines, and every error in it is a deliberate probe: 9 CORS
    (`api-security`), 4 SSRF/URL refusals, 1 `FOREIGN KEY` (`image-upload`'s FK-fault
    probe, named in `routes/products.js`), 1 `CHECK` (`nonstring-body-shape` T15's
    `status: 'bogus'`), and 3 `multipart-malformed` 400s.
  - ⚠ Grep for „malformed" hits those multipart lines. That is NOT `disk image is
    malformed`: read the line before calling the DB corrupt.
- Every mutation in §2–§5 was applied from a scratchpad backup, `cmp`-verified to have
  changed the file, rebuilt when it was frontend code, run, then restored and
  `cmp`-verified identical. A clean build was the last thing served.

- **Review re-gate:** `--list` gives 2327 tests in 92 files (+1, the census fixture test).
  Rebuilt, then a fresh DB + server. Four files asked, four ran, per-file counts equal to
  `--list`: `portal-fidelity` 19, `portal-profile-modal` 53, `portal-session-boundary` 3,
  `portal-shell` 32. **107 passed / 0 failed / 0 skipped**, 1.1 min, server log clean.
  Edited e2e files are still **4**; the test count is now **2312 → 2327**.

The pre-fix reds, which are the other half of the mutation evidence: own-order
`.display` 19.8px, `.when` 17.25px, history total 16.2px, state-modal scrim 330 > 320,
drawer 1016 > 271 and then 1194 > 320. F5 (a permanent footer column) reddened only „one
row at 378px".

### What PI-T12 LEAVES BEHIND (module 18 closes here)

1. ⚠⚠ **The date-format PO question is still open** (§PI-T1 §1, PI-T4 §1). The closed
   landing prints the same date in two formats, and `portal-landing` §5 pins both halves.
   Whichever way the PO rules, exactly one of those expectations is the edit.
2. **The spec text of item 13 was wrong about two of its four sites**, and it is amended
   in place. A future A10 list is DERIVED from the canon, never from a spec sentence: grep
   `portal2.jsx`/`portal2.css` for the element's `lineHeight`, and only a silent one is A10.
3. **`noLayerOverflow()` is the modal-layer 320px instrument** (`portal-fidelity.spec.js`).
   A spec measuring a dialog or the drawer should use that shape, not `documentElement`.
   Other files' 320px dialog tests (`share-dialog`, `guest-payment-modal`,
   `order-modals`) measure `.m-foot`/the scrim their own way and were NOT audited here.
4. **The drawer walk names its rows** (`WALKED_ROWS`) and reds on an unknown one. A new
   drawer item (WA-T*, GL-T6's standing link) adds a stop in
   `portal-session-boundary.spec.js` in the same commit.
5. **The auto-open counts are pinned numbers (10 mounts, 8 terms).** A new overlay on
   `FriendPortalSession.vue` changes at least the mount count. Re-walk the derivation, then
   edit the numbers; never edit the numbers alone.
6. **PI-T3 §2's homeless property stays homeless**, on purpose. It stops being homeless
   the day something reloads `cycles` in-session, and that row inherits the
   `guestCountSeq` guard and owes the test.

## §PO-copy — „Ako to funguje" copy pass (PO 2026-09-29)

The PO rewrote the explainer's copy. `PortalExplainer.vue` changed as follows:

1. **The whole page is TY-form** („môžeš", „dozvieš", „Naklikáš … odošleš", „Vyzdvihneš",
   „Ako sa ku káve dostaneš", „Objednávaš … odovzdá ti ju", „Nie si z Bratislavy? Objednaj si a
   nechaj poslať", „dostaneš … Zaplatíš"). It is the ONE friend surface that does this. Every other
   screen stays vy-form. Note the LandingStateModal captions („Pauza · Objednávky · Doručenie") are
   a different component and were NOT renamed.
2. Phase 1 title „Pauza" → **„Čas na kávu"** (its text and the `pause` icon are unchanged).
3. The „Odberné miesto v Bratislave" row is now a **static sentence** (Petržalka / Legova práca
   delivery offer). The list of active pickup points is gone, and with it the component's only
   fetch (`api.getPickupLocations('coffee')`, `onMounted`, `pickupParts`, the `data-user-copy`
   spans). The checkout picker still lists the points. `portal-explainer.spec.js` §4 now pins
   that NO request goes to the feed and that a name from a stubbed feed never reaches the page.
   `portal-vocabulary.spec.js`'s „a pickup location's name and address" test now pins that
   absence as well. §8's 320px floor lost its 120-char name and is measured on the static page
   with the Packeta fee badge ON.
4. The note now ends „…napíš mi na WhatsApp a určite doriešime." and is signed **„— Lego"**,
   with an **„L"** avatar (it used to be „— Karol" / „K").
5. Round 2 (same day): the Bratislava sentence says „v okolí **mojej** práce" (it said „Legovej"), the
   intro is first-person singular („otvorím objednávky, nakúpim …", but still „rozdáme si"), and way 2
   is titled **„Cez priateľa / kolegu"**. `portal-explainer.spec.js` pins the full intro and that title.
6. „Ak si tu nový/á" is the PO's own slash form. Reproduce it; do not „fix" it into the
   gender-neutral rule.
