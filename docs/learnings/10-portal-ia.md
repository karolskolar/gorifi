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
(`defineExpose({ openShareDialog })` ↔ `landingOrder.value.openShareDialog()`).

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
   — and they need PI-T4/T5 to exist first.
3. ⚠ **`portal-session-boundary.spec.js`'s walk lost two stops** (archive fold, subscription
   modal) because both surfaces are gone. §UC-PI-019 item 14's drawer-based rewrite (history,
   balance, explainer) is still PI-T12's.
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
   `title="Objednávky sú uzamknuté"` and the §UC-PI-007 intro and changes nothing else;
   a second modal component is the defect this parametrisation exists to prevent.
2. **`FriendOrder`'s `readonly` is PI-T5's too** — but §UC-PI-007 keeps the TABGROUP on the
   locked landing („Kolegovia hand-over ticks happen precisely now"), so that row needs a
   third switch rather than a reuse of this one. The `v-if="!isReadonly"` on the tabgroup
   is the line it will have to split.
3. **Landing slot 3 (the debt banner) is still empty in the closed branch too** — PI-T7's,
   and marked in the template where it goes.
4. ⚠ **PI-T12 owes `portal-fidelity` the A10 pins for the new surfaces** (`.banner.slim`
   on the closed banner, `.field-lbl` in the caption row, the 38 px `.display` in the
   modal's card) and a 320 px hostile-text pass over the closed state.
5. ⚠ **`portal-vocabulary.spec.js` (PI-T11) must add `components/LandingStateModal.vue` to
   §UC-PI-017's grep list** — it is a friend surface with Slovak copy and it is in no file
   list today.
