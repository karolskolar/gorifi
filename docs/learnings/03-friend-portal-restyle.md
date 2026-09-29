# Podpultovka friend/guest portal restyle — .app cascade, FriendOrder shell, product cards, fonts, CatScrollArrow, CartLineList, domain/brand, invite screen, iOS zoom, script-setup scope

> Moved verbatim out of `CLAUDE.md` on 2026-09-03 (it had grown to 153 KB). These are the full per-task learnings; the load-bearing rules are summarised in `CLAUDE.md` → Hard rules. **Append new learnings for this area HERE, and add only the one-line rule to `CLAUDE.md`.**

### ⚠ `<script setup>` has NO module scope — a singleton declared there is per-instance (ML-T3, 2026-08-15)

`<script setup>` compiles its **entire body** into the component's `setup()`, so a
`const` at its top level is created **fresh for every component instance**. Only
`import`s are hoisted out. A module-scope singleton in an SFC therefore needs a
**plain `<script>` block alongside** `<script setup>` — that is the only way to get one.

Found on `MagicLogin.vue`'s single-shot redemption guard: it lived in `<script setup>`,
*looked* module-scope, and was per-mount — so an in-SPA Back to `/magic/:token` fired the
POST again and **spent a single-use login credential twice**. Caught only by the guard's
own e2e ("Expected: 1, Received: 2"); nothing else would have noticed, because the server
correctly refuses the replay and the page shows the same neutral card either way.

⚠ **It fails silently in exactly the cases that matter** — a guard, a cache, a
"warn once" flag, an in-flight-request dedupe. Verify in the BUILT chunk if unsure: the
declaration must sit at module top level, not inside `setup(…)`.


### ⚠ `.app > *` neutralises every Tailwind positioning utility (Podpultovka redesign, 2026-08-07)

`friends-theme.css` (RD-DS-1) declares `.app>*{position:relative;z-index:1}` to keep content above the halftone `.app::before` texture. That rule is specificity `(0,1,0)` — **the same as every Tailwind positioning utility** — and `friends-theme.css` is imported *after* `style.css`, so on a **direct child of `.app`** it wins. Measured live:

| direct child of `.app` | computed |
|---|---|
| `class="fixed z-50"` | `relative / 1` ❌ |
| `class="absolute z-40"` | `relative / 1` ❌ |
| `class="sticky top-0 z-40"` | `relative / 1` ❌ |
| `class="relative z-10"` | `relative / 1` ❌ (z-index silently clamped) |
| theme `.cartbar` / `.cat-tabs` / `.modal-layer` | `sticky 50` / `sticky 40` / `fixed 200` ✓ |
| the same utilities **nested one level deeper** | survive ✓ |

The theme's own classes survive only because they sit *later in the same stylesheet* than `.app>*`. Secondary effect: every direct child becomes a **stacking context**, so `z-*` inside one can no longer compete across siblings.

**This fails silently** — no build error, no failing spec, just a modal that lays out in page flow or a bar that stops sticking. UC-DS-001 states the rule abstractly but names only the `h-screen` collision; the positioning half is the one that actually bites.

**Rule:** a hand-rolled `position:fixed` overlay that is a direct child of `.app` must either **teleport out of `.app`** (correct when its subtree uses no theme tokens — it then also keeps the old `system-ui` font instead of inheriting `var(--font-body)`, which is what "visually untouched" actually requires) or be **rebuilt on `NeoModal`/`.modal-layer`** (correct when it does want the tokens). Radix-portaled dialogs (all shadcn `Dialog`s, `PaymentModal`, `GuestShareDialog`) and `NeoModal` are immune — the risk is confined to hand-rolled overlays.

Known call sites, enumerated when RD-FL-1 landed the first `.app`:
- `FriendPortal.vue` voucher overlay — **fixed in RD-FL-1** via `<Teleport to="body">`; the view now has zero exposed direct children.
- ~~⚠ `FriendOrder.vue` `<header … sticky top-0 z-40>` is a **direct child** of the root.~~ **Resolved in RD-FO-1**: the header is gone, replaced by the non-sticky `BrandChrome`. `order-shell.spec.js` asserts `header` count 0, `.appbar` computing `position: relative`, and the appbar moving 1:1 with the page.
- ~~⚠ `FriendOrder.vue` `TabsList … class="sticky top-16 z-30"`~~ **Resolved in RD-FO-1**: it is `.cat-tabs` now, `top: 0` from the theme, which is correct precisely because nothing above it is pinned any more. Pinned by `order-shell.spec.js` (`top`, `z-index`, and the strip's box actually reaching y = 0 after a scroll) — `mobile-no-h-overflow.spec.js` would not have caught a wrong `top`.
- ~~`FriendOrder.vue` /~~ `GuestOrder.vue` / `GuestOrderStatus.vue` hand-rolled `fixed bottom-0 z-50` cart bars are *nested* inside their page-column div, so they survive as-is. Do not "tidy" them up to root level while they are still on Tailwind utilities. **`FriendOrder.vue`'s is resolved (RD-FO-3)**: it is now `.cartbar` and a **direct child of `.app`**, which is safe **only** because the theme's `.cartbar` rule sits *later* in `friends-theme.css` than `.app>*` at equal `(0,1,0)` specificity — proven by counterfactual, live: a plain `<div class="sticky bottom-0 z-50">` appended to `.app` computes `relative`/`z-index:1`, and the same node with `.cartbar` added computes `sticky`/`50` (rule indices 637 vs 741). RD-GX-1 gets the same free pass **only** when it converts to the theme class — not before.

### FriendOrder shell — the neobrutal chrome, banners, switch and category strip (RD-FO-1, 2026-08-08)

`frontend/src/views/FriendOrder.vue` is now an `.app` scope (04 §UC-FO-001..004). **Shell only** —
product cards (RD-FO-2), the cartbar (RD-FO-3), the modals (RD-FO-4), the locked composition
(RD-FO-5) and the Kolegovia panel's *contents* (RD-KG-1) are still on the old skin by design.

- **Appbar subtitle is the friend's NAME ONLY.** The prototype shows "Lego · X42KPGZZ", but
  `GET /orders/cycle/:id/friend/:id` returns `{id, name, packeta_address}` and `friends.js` strips
  `invite_code` from every friend response. Module 03's portal appbar sources its uid from the
  *session*, which `guest-host-view.spec.js:641-647` proves is **optional** in the stored shape — so
  a code here would render for some friends and not others. Consistency won; revisit only if a
  client-side code source becomes guaranteed.
- ⚠ **The green "odoslaná" banner now YIELDS while unsent changes exist**
  (`isSubmitted && cartItems.length > 0 && !hasUnsubmittedChanges`). That is the prototype's
  `submitted && !dirty && lines > 0` — a deliberate handoff UX change, in contract, and the cartbar
  warning carries the state instead. It is a *condition*, so nothing but a spec can catch its loss.
- ⚠ **The badge computeds live in this view and module 05 must never re-own them.**
  `guestBadgeIsPending = isLocked && pendingDelivery > 0`, `guestBadgeCount = pending ? pendingDelivery : count`,
  fed exclusively by `GuestSubOrders`' `summary` emit. The badge has to be right *before* its tab is
  opened, which is only possible from the parent. Visuals follow the prototype and semantics follow
  the repo (resolved conflict #1): plain white `.tabbadge` at rest, amber `.tabbadge.pending` only
  when locked with an outstanding hand-over. The prototype paints pending unconditionally — wrong here.
- **Both panels stay `v-show`.** Same rule as 2026-08-07, now also asserted structurally
  (`#panel-guests` present in the DOM with `style.display: none` while the own tab is active).
- **One product list, not two.** The radix `TabsContent` panels and the "only one purpose" fallback
  were byte-divergent copies of the same card markup, and the fallback was the **poorer** copy in
  **four** ways: no roast/roastery badges, no `canIncrement` on "+", **no stock-limit bar at all**
  (no `getRemainingGrams`, no "Vypredané"), and **no 500 g variant** — its own comment said so
  verbatim: `<!-- Weight variants (150g / 200g / 250g / 1kg) -->`. The two that mattered HID PRODUCT
  from the user: on a single-purpose cycle a 500 g option was unbuyable and no stock bar existed
  even when the product had a `stock_limit_g`. ⚠ The
  missing `canIncrement` was **cosmetic only** — `increment()` already returns early on
  `!canIncrement` (`2ecb934:519`), so the button was *dead*, not an over-order path; an earlier
  version of this note claimed the limit "could be stepped past", which is wrong. Collapsed into
  `activeProducts` (the active purpose only): after stripping indentation the surviving card block is
  byte-identical to the `TabsContent` one apart from the `v-for` source, so nothing was lost from the
  richer copy. Net −280 lines and one card for RD-FO-2 to restyle; the strip is still absent when
  there is a single purpose.
- **`.tabgroup` fits 320 px — and the BADGE, not the label, is what spends the margin.** The model is
  `min₁ + min₂ + gap ≤ content`: `grid-auto-columns: 1fr` is `minmax(auto, 1fr)`, so each track floors
  at its own min-content and only the surplus is shared. "Moja objednávka" therefore legitimately
  **exceeds** its half cell (136.2 px border-box against 133.5 px) and the Kolegovia track hands the
  difference back. ⚠ An earlier version of this note read the tab's `clientWidth` (132) against its
  own border-box (136.2) and called the 4.2 px difference "spare" — it is the tab's own transparent
  2 px border, not slack. Measured at 320 px (content box 272 px, gap 5 px): **41.3 px** headroom with
  no badge on Figtree, 32.5 px on the fallback face, **12.3 px with a 1-digit badge** (the shipped
  state), 3.6 px with a 1-digit badge on the fallback face — and a 3-digit badge on the fallback face
  **overflows by 2 px**. No override shipped, but the margin is thin and data-dependent.
  ⚠ Neither `mobile-no-h-overflow.spec.js`'s seeded cycle nor `order-shell.spec.js` originally put a
  badge on screen at 320 px, so the tight case was **untested**; `order-shell.spec.js`'s 320 px test
  now creates a real guest sub-order, asserts the badge is rendered (a non-vacuity gate) and asserts
  the headroom stays positive. If an override is ever needed it goes on `.tabgroup .tab` only and
  **cannot be a Tailwind utility** — that selector is `(0,2,0)` and `friends-theme.css` loads after
  Tailwind, so it needs a scoped block.
- ~~⚠ `successMessage` ("Košík bol uložený")~~ **RETIRED in RD-FO-3.** It was reachable, unreadable, and once actively wrong: `saveCart(false)` was its only writer and `doSubmitOrder()` its only non-silent caller, so it had **no user-initiated trigger** — after a successful submit it rendered behind the success modal, which navigates away on close, and after a **failed** submit it sat plainly **next to the error banner**, "saved" and "failed" side by side for 3 s. Retired rather than cleared, because clearing would have left a ref, a timeout and a banner no reachable state ever shows. Pinned by a test that stubs the submit to 500 and asserts the error banner appears **alone**.
- The Kolegovia **share card** (RD-KG-1's to restyle) is pinned by TEXT, not structure — the
  accessible names `Zdieľať objednávku s kolegami` (`guest-link.spec.js:259`,
  `guest-host-view.spec.js:945`) and `Zdieľať odkaz`, matched as `/Zdieľať/` when a locked cycle
  asserts count 0 (`guest-host-view.spec.js:929`), plus `getByText('Objednávate aj pre kolegov?')`
  (`:944`). Its `p-4` is **not** pinned: `guest-link.spec.js`'s `div.p-4` `cardFor()` locator only ever
  runs after `page.goto('/')`, i.e. on the **portal**, so the "never use the `p-4` shorthand" rule
  belongs to `FriendPortalSession.vue` (where it is documented) and does not constrain this route —
  UC-DS-004 rule 2 lists `p-4` among the allowed layout utilities. The order page's column uses axis
  utilities for consistency with the portal, not because a spec requires it.
- **snapTab is proven by A/B, not asserted** (02 §UC-DS-012's deferred obligation, discharged in
  `e2e/tests/order-shell.spec.js`): the same tab, same page — `snapTab` centres the strip and leaves
  `window.scrollY` at 0, `scrollIntoView()` scrolls the *document*. ⚠ Both halves need a **short
  viewport**: with one card per purpose the page does not scroll at 844 px tall and `scrollIntoView`
  looks as innocent as `snapTab`. ⚠ The centring tolerance is 24 px because `.cat-tabs` is
  `scroll-snap-type: x proximity` and re-snaps to the nearest tab edge after the smooth scroll
  (measured 5 px off the ideal centre), and Chromium serialises that computed value as bare `"x"`.
- The back chevron, both switch tabs and every category tab carry the house zero-pixel ARIA layer
  (role + tabindex + Enter/Space). Not decoration: the controls they replace were a real `<button>`
  and radix `TabsTrigger`s, both natively focusable — pointer-only spans would have been an
  accessibility **regression**, and the Kolegovia panel plus every non-first category would have
  become keyboard-unreachable. ⚠ The chevron's label is **"Späť"**, not "Späť na zoznam cyklov":
  the fatal-error state renders a button with that exact text and Playwright matches accessible
  names as a case-insensitive SUBSTRING unless `exact: true`.
- Dropped with this row: the per-category page tint (`backgroundClass`) and the coloured
  `TabsTrigger` classes (resolved conflict #7) — the active tab is `.tab.on` and nothing else.
  `Alert`, `Badge` and `Tabs*` imports are gone; `Card`/`CardContent`/`Button`/`Dialog*` stay because
  RD-FO-2..4 still own that markup.

Full suite after this work: **367 passed / 3 skipped** (+14, zero pre-existing specs modified).

### RD-FO-2 — product cards, the `.vbox` matrix, the stock bar (04 §UC-FO-005..007)

- **One card root, two bodies.** `Card`/`CardContent` are gone from the product list; `.card` IS the
  neo card. `FriendOrder.vue` still imports them for the Kolegovia share card (RD-KG-1), and `Button`
  for the **modals** (RD-FO-4) and that same share card — the cartbar stopped needing it in RD-FO-3.
  Do not "clean up" those imports before RD-FO-4 and RD-KG-1 both land.
- ⚠ **`GuestProductGrid.vue` is the guest-side twin and deliberately stays on the OLD skin until
  RD-GX-1.** Its `getGroupQuantityTotal` (the whole-card `ring-2 ring-primary`) still exists there;
  the friend view's copy is gone, because 04 §UC-FO-007 replaces the ring with per-`.vbox` `.sel`.
- ⚠ **`COFFEE_VARIANTS` is the fixed order and the CART KEYS.** One `.vbox` per non-null price field:
  `price_150g/200g/250g/500g/1kg/20pc5g` → `150g … 20pc5g`. The old template gated every weight
  behind `v-if="!product.price_20pc5g"`, so a product priced for capsules **and** weights showed only
  the capsules — a published price nobody could buy. Only `label` is presentational
  (`20pc5g` → "20 ks × 5g"); the `variant` string is `order_items.variant` and `variantGrams`' key.
- ⚠ **The gram math is untouched (04 resolved conflict #6).** `getRemainingGrams` / `canIncrement` /
  `variantGrams` / `loadAvailability(excludeFriendId)` are verbatim; only the DISPLAY became kg.
  `kg(g) = Math.round(g/10)/100 + ' kg'` — up to 2 decimals, trailing zeros stripped, dot decimal
  (historical: the rule got ONE home in `lib/kg.js kgLabel` in FUP-T24, 2026-09-20 — §FUP-T24 below)
  (250 → "0.25 kg", 1000 → "1 kg", 1250 → "1.25 kg"). A `toFixed(2)` "tidy-up" would render "1.00 kg".
  The fill includes the friend's **own uncommitted cart**, so the bar moves before anything is saved.
  Fill is always accent magenta; the sold-out signal is the danger-red **"Vypredané"** LABEL, never a
  bar colour (the old amber/red bar tinting is gone).
- ⚠ **The `+` ceiling is BOTH `incDisabled` AND the `canIncrement` re-check in `onQty`.** 02
  §UC-DS-008 forbids a `max` in `NeoStepper`, so the rule lives in the view. `incDisabled` carries the
  shipped `:disabled` semantics to assistive tech and costs no fidelity — RD-DS-3 recorded that the
  theme has no `.stepper button:disabled` rule, so the button looks identical, which IS the silent
  refusal 04 §UC-FO-006 asks for. `onQty` routes every increase through `increment()`, so a click that
  bypasses the disabled attribute still cannot exceed the limit. Never bind `setQuantity` to a
  stepper's `update:modelValue` — that hands it an unchecked write and retires the ceiling.
  ⚠ **But the `onQty` half is NOT test-covered, and cannot be.** `NeoStepper.inc()` returns early on
  `incDisabled`, so a forced click never reaches `onQty`; `incDisabled` and `canIncrement` read the
  same state in the same tick, so there is no e2e-reachable state where the button is enabled and the
  increment would still exceed the limit. The suite pins `incDisabled` + the silent refusal only.
  Consequence for **RD-FO-3**: if the cartbar's steppers omit `incDisabled`, nothing in the suite
  notices the ceiling going away — bind it, and don't trust a green run as proof.
- ⚠ **The 368px column fallback — and it is 368 because `.card` has a 3px border.** 04 §UC-FO-005
  mandates `1fr 1fr` for >1 variant. A `.vbox`'s min-content is 146px (the 38+24+38 stepper plus two
  10px gaps = 120, plus 11px padding and 2px border a side); two of them plus the 10px gap need 302px
  of card CONTENT box, and that box is `viewport − 32 (page column) − 28 (card padding) − 6
  (`.card`'s own `border:3px`, friends-theme.css:45)` ⇒ **368px**. At 378px the tracks are 151px,
  which only reproduces from `−66`; a `−60` derivation predicts 154px and is how the number first
  shipped as 362.
  ⚠ **The 6px error was invisible.** `grid-cols-2` is `repeat(2, minmax(0,1fr))` — track minimum
  **zero** — so across 362–367 the tracks sat *below* min-content and the shortfall was absorbed by
  the flex stepper buttons shrinking to 36.5–37.75px, silently losing the 38×38 hit target 02
  §UC-DS-008 pins as "from CSS — do not override". Pinned now by the 364px case in
  `order-product-card.spec.js`; any future breakpoint on this grid must assert button size, not
  just column count.
  ⚠ **The media query is NOT what satisfies `mobile-no-h-overflow`** — the class-vs-inline switch is.
  Forcing `grid-cols-2` at 320px gives a document overflow of **0** (122px tracks, 26px buttons: ugly,
  not overflowing). The 15px overflow only appears with the spec's literal inline
  `gridTemplateColumns:'1fr 1fr'`, because bare `1fr` is `minmax(auto,1fr)` and `auto` floors the track
  at min-content. So `grid-cols-*` CLASSES exist for two reasons — a media query cannot reach an
  inline style, **and** `minmax(0,…)` is what stops the document scrolling — while the media query's
  own job is protecting the `.vbox` from being squeezed. RD-GX-1 inherits this whole derivation.
- ⚠ **`min-w-0` is not `overflow-wrap`.** Both product-card text columns carry an inline
  `overflow-wrap:anywhere` (the RD-FL-4 `plan_note` precedent). `min-w-0` lets the flex item SHRINK;
  an unbreakable token still paints outside it — a 44-char space-free product name put the `<h3>` at
  479px inside a 183px column and scrolled the document **263px** sideways at 320px. Set on the
  CONTAINER, not the `h3`, because `overflow-wrap` inherits and `description1`/`description2` are
  equally free admin text. A hyphenated name does **not** reproduce it (`-` is a break opportunity),
  which is why the fixture name is spelled without one.
- **`phone` is CSS, not a reactive.** The prototype's `phone` is a demo frame toggle
  (`device === "phone"`), not a media query; this port expresses it as Tailwind `sm:` like module 03
  already does (`px-4 sm:px-7`). No `resize`/`matchMedia` listener exists on this view — do not add
  one. ⚠ The one thing a class **cannot** carry is `line-height`: `friends-theme.css` loads after
  Tailwind and `:where(.app,…) .display` ties `leading-[0.95]` on specificity, so every line-height
  in these cards is an INLINE style.
- Text metrics: every text-bearing element in both cards carries an A10-covered class
  (`.display`, `.badge`, `.sub`, `.mono`, `.vbox .vsize`, `.vbox .vprice`, `.stepper .val`), so no
  call-site `line-height:normal` was needed and **A10's selector list did not grow**.
- ~~⚠ `.pimg` no-photo = the BARE FRAME~~ **SUPERSEDED (product decision 2026-08-20): `.pimg` is
  RETIRED at both call sites** (`FriendOrder.vue`, `GuestProductGrid.vue`). The photo is now a bare
  `<img>` rendered as imported — no frame, no border, no dark gradient (transparent backgrounds stay
  transparent), `height:auto` so it is NEVER cropped (the old `object-fit:cover` was), `self-start`
  so it top-aligns with the product name, and only as tall as the image itself; a product with no
  photo renders **nothing at all**. The theme's `.pimg` rules stay in `friends-theme.css` unused
  (canon port — same treatment as the dead `.pimg .lbl`). Pinned in `order-product-card.spec.js`
  with a 40×30 transparent fixture PNG whose 4:3 ratio (58px column ⇒ 43.5px) is the numeric proof
  of "not cropped". ⚠ The whole image story is interim: the planned DB consolidation makes products
  global (one image per product, not per cycle snapshot), and the 13 MB-JSON payload finding from
  2026-08-20 rides on that too.
- ⚠ **Tapping the photo opens a LIGHTBOX** (same day, follow-up decision — 58px cannot show the text
  printed on a coffee bag). `components/ProductImageModal.vue` is the **one home**, with two call
  sites (`FriendOrder.vue`, `GuestProductGrid.vue` — which itself serves `/g/:token` *and* the
  status/edit screen); each call site owns only its `photoProduct` ref. Built on **`NeoModal`, never
  a hand-rolled overlay**: the order screen is an `.app` scope, so a hand-rolled `position:fixed`
  overlay would silently compute `relative` (the `.app > *` rule) — pinned by asserting the dialog is
  teleported OUT of `.app`, that `.modal-layer` really computes `fixed`, and that the body scroll
  lock is taken *and released*.
  ⚠ **The image is `width:100%` + `height:auto` with DELIBERATELY NO `max-height`.** A `70vh` cap was
  written first and removed after measuring: with `width:100%` the box becomes 100% × 70vh, so a
  **portrait** photo (what a coffee bag usually is) gets letterboxed with dead bands either side and
  renders *smaller* than the dialog allows — the exact complaint the row answers. Without the cap a
  tall photo just makes the dialog tall and `.modal-scrim` (already `overflow-y:auto`) scrolls it.
  Mutation-verified: re-adding `max-height:70vh;object-fit:contain` reddens exactly two tests in
  `product-photo-lightbox.spec.js`. Measured at 390px: **310 × 465** against 58px on the card.
  The photo stops being decorative, so `alt=""` became a real name plus the house zero-pixel ARIA
  layer (role/tabindex/Enter/Space) — it is the ONLY route to the full image, so pointer-only would
  be a keyboard regression. Its accessible name is `Zobraziť fotku: <product>`; no shipped spec has a
  role-based button lookup that can now collide (checked).
- Product name is `<h3 class="display">` on **both** card types (04 §UC-FO-015 pins
  `getByRole('heading')` for `guest-host-view.spec.js`); on the bakery card it is additionally
  `inline` so the subtitle sits on its baseline.
- `NeoStepper`'s first regression net is `e2e/tests/order-product-card.spec.js` (02 §UC-DS-014 item 6):
  v-model round-trip, the `min` floor **and its no-emit rule** (a no-op tap at 0 must not dirty the
  cart, or the leave guard fires on nothing), the stock ceiling, and the `.sel` flip.
- ⚠ **`order-shell.spec.js:337/342` were re-pointed** from `{ name: '+' | '-', exact: true }` to
  `{ name: 'viac' | 'menej' }` — 03 §UC-FL-013 case (b), structurally unsatisfiable against a
  mandated primitive (`NeoStepper` labels its buttons in Slovak and renders U+2212, and an aria-label
  wins over text content, so **both** lookups broke). One pre-existing-spec file edited: **0**;
  pipeline-authored spec files edited: **1**, two lines.

Full suite after this work: **379 passed / 3 skipped** (+12).

### Podpultovka friends-portal restyle — what survives it (2026-08-09)

A 25-row, frontend-only re-skin of the friend + guest portal (`friends-theme.css`,
`components/neo/`, `.app` / `.modal-layer` roots). ⚠ **`git diff 7c3f85e..HEAD -- backend/`
is empty** — every GSO-T1..T10 rule above still holds verbatim, and `frontend/src/api.js`
was never touched, so no request shape or header set moved.

- ⚠ **`.app > *` neutralises Tailwind positioning utilities on a direct child.** No build
  error, no failing spec — `.cartbar` stays sticky only by cascade order. A plain
  `sticky` div as a direct child of `.app` computes `relative`.
- ⚠ **`.m-foot .btn` is `nowrap` + `flex:1` with `min-width:auto`, so a too-wide modal
  footer gives NO degradation signal** — no shrink, no wrap, no ellipsis; it paints
  outside the border and hands the scrim a scrollbar. Measure **min-content**, never the
  flex-resolved width. The ≤400px padding relief is invisible only while the even split
  clears **both** floors — three rows recorded "invisible at every width" and **two were
  false**. Never generalise one footer's verdict to another button pair.
- ⚠ **Tailwind preflight sets `svg{display:block}`**, which breaks an inline icon+text
  badge onto two lines. Fix at the call site with `inline-flex`, never by widening the
  theme's `line-height:normal` selector list.
- ⚠ **`v-if` on modal mounts is load-bearing** — shipped specs locate "Zavrieť" unscoped,
  so an always-mounted dialog matches them and its scrim swallows clicks.
- Playwright matches role names as a **case-insensitive substring** unless `exact: true`.
- Vue's `condense` deletes a newline-bearing whitespace node between elements, silently
  concatenating adjacent strings.
- Session state: `FriendPortalSession.vue` is keyed on the **auth handshake, not the
  friend id** — keying on identity flushes at the first `await` while `entry` is seeded
  once at setup, so friend B mounted with friend A's data (six consecutive leak bugs,
  worst of which auto-opened B's credential dialog pre-filled with A's plaintext password).

**Running the e2e suite locally** (528 tests, ~11 min) — three harness traps that each
produce plausible wrong numbers:
- ⚠ **`CORS_ORIGIN` must include the gate's own origin.** The default allowlist is
  the skolar.sk pair + the podpultovka.biz trio + `localhost:5173` (see `index.js`), so a
  same-origin SPA on `localhost:3997` gets **500 on every XHR** and renders a blank body —
  surfacing as ~31 unrelated-looking UI failures that read exactly like a regression.
- ⚠ **`e2e/seed.mjs` is not optional** on a fresh `DB_PATH`, or every admin-authenticated
  spec fails at the login field.
- ⚠ Confirm the port is **free first** (a stale server serves a `backend/public` deleted
  underneath it), check `echo "EXIT: $?"` rather than piping through `tail` (which returns
  *tail's* status), and remember `pkill -f` matches its own shell — chain nothing after it.


### `.cat-tabs` scroll affordance — `CatScrollArrow.vue` (2026-08-10)

The theme's only overflow signal on the category strip was `.cat-tabs::after`, a 28px
`transparent → --bg` fade. Users read it as a soft edge, not as "there is more to the
right", so categories past the fold went unfound. `components/CatScrollArrow.vue` adds an
accent control at the strip's right edge that both signals the overflow and performs the
scroll. **No theme rule was added** — `friends-theme.css` is untouched and its adaptation
list still ends at A11; the whole control is one SFC with `<style scoped>`.

- **ONE component, TWO call sites** — `views/FriendOrder.vue` and
  `components/GuestProductGrid.vue` (which itself serves both `/g/:token` and the
  status/edit screen). They are the same control; never inline a second copy.
- ⚠ **It must stay the LAST DIRECT CHILD of `.cat-tabs`, and it finds that scroller via
  `parentElement`** — not via a prop. `position:sticky` only pins against the scroll
  container the element actually lives in, so "the element I am a child of" and "the
  element I control" are necessarily the same node; a prop could disagree with the DOM.
- ⚠ **Sticky-inside-the-horizontal-scroller is the only technique that works**, and it is
  the theme's own (`.cat-tabs::after` is `position:sticky; right:-1px`). Do **not** wrap
  `.cat-tabs` in a positioned container to get `position:absolute`: `.cat-tabs` is itself
  `position:sticky; top:0`, and a wrapper box its own height leaves it no travel — it
  silently stops sticking (`order-shell.spec.js` pins top/z-index/y=0-after-scroll).
  `display:contents` generates no box, so it rescues nothing.
- ⚠ **`z-index: 2` is load-bearing.** `::after` is generated content — last in paint order —
  and is itself sticky with `z-index:auto`, so without it the fade washes over the arrow.
  Pure appearance bug: every behavioural assertion still passes. Pinned by **sampling the
  rendered pixel** (screenshot → `data:` URL → canvas → `getImageData`), because the thing
  covering it is a pseudo-element that cannot be located or hit-tested. Mutation-verified:
  removing the z-index reads `rgb(255, 165, 199)` against the accent's `rgb(255, 45, 135)`.
- ⚠ **`margin-left: -44px` cancels the arrow's contribution to `scrollWidth` exactly** —
  its own `36px` plus one more `8px` flex `gap`. Without it a strip whose tabs comfortably
  FIT reports an overflow and renders an arrow that scrolls nowhere, and `scrollWidth`
  moves as the arrow appears/disappears at the right end. The 8px is the theme's
  `.cat-tabs { gap: 8px }`; if that gap changes, this number moves with it.
- ⚠ **The hidden state is `display:none` AND `position:static`**, and the element is always
  rendered (class toggle, not `v-if`) so `parentElement` survives. A `position:sticky`
  element still *computes* as sticky while `display:none`, which would have put a hidden
  affordance into `guest-order-shell.spec.js`'s exact sticky census. That spec's fixture
  has two purposes that fit, so it honestly still reads `['cat-tabs','cartbar']`; the set
  **with** the arrow showing — `['cat-tabs','catarrow on','cartbar']` — is pinned in
  `cat-scroll-arrow.spec.js`. It is not a fourth page-edge bar: it rides the strip's own
  right edge, inside the scroller.
- ⚠ **`aria-hidden="true"` + `tabindex="-1"`, deliberately.** `.cat-tabs` is a
  `role="tablist"` whose children are `role="tab"`; a focusable control there breaks the
  ARIA contract and inflates the count `mobile-no-h-overflow.spec.js:84` asserts. Same
  basis as the appbar's profile pencil — exactly one control answers to an action's name,
  and this is an adjacent, pointer-only duplicate of scrolling. Nothing is lost: the tabs
  are focusable and focus scrolls them into view.
- Re-measures on `scroll`, on a `ResizeObserver` (disconnected on unmount) **and on
  `document.fonts.ready`** — tab widths are font-metric driven and Figtree loads async, so
  the first measurement runs against the fallback face.
- Judgement call, recorded: the arrow overlays the strip's rightmost ~40px, so a tab
  resting exactly there is partially un-tappable. No `scroll-padding-right` was added —
  tabs are ≥70px wide so a clickable region always remains, and the arrow withdraws at the
  right end, which is where it would bite most. Revisit if short category names appear.

Full suite after this work: **554 passed / 3 skipped** (+9).

### Colleague kilos on the portal card + grouped cart lines (2026-08-12)

Two product decisions, **frontend only** — `git diff -- backend/` is empty, `api.js` is
untouched, and no request shape or endpoint moved. Both were specified from screenshots
of a redesigned card / cart bar.

**1. The portal cycle card's share row now prints the colleagues' QUANTITY.**
- Two lines: `3 kolegovia · 4 kg` (emphasised, `data-testid="share-row-count"`) over
  `objednali cez váš odkaz`. This **retires the `.tabbadge` chip** and the single
  "N | kolegovia cez váš odkaz" line. The count alone answered the host's real question —
  how much coffee am I collecting for other people — only if every colleague buys one bag.
- ⚠ **No new request and no new endpoint.** `GET /api/guest-links/cycle/:id` already
  carries `guest_orders[].items` (`helpers/guest-orders.js attachItems`), so
  `summariseSubOrders()` sums grams client-side off the payload the concurrency-capped
  batch already fetches. `guestCounts` became **`guestSummaries`** = `{count, grams, units}`
  keyed by cycle id; every RD-FL-5 rule about it still holds (sequence guard, merge map
  that does not heal on error, non-blocking, context-only).
- ⚠ **`count` comes from the server's `totals`, the quantity is derived** — so the number
  beside the kilos can never disagree with the host's "Objednávky kolegov" tab. Cancelled
  sub-orders count for **neither** figure (the same status predicate every backend guest
  aggregate applies); pinned with a cancelled 1 kg bag that must not reach the screen.
- ⚠ **Trailing zeros are STRIPPED here ("4 kg", not "4.00 kg")** — the RD-FO-2
  `Math.round(g/10)/100` rule (one home since FUP-T24: `lib/kg.js kgLabel`),
  deliberately NOT `formatKilos`, which the "Objednané ·"
  badge in the same card still uses. The two are fed different units (kg from the API vs
  grams summed off items) and the design canon for this row prints "4 kg".
- ⚠ **An empty quantity drops the "· " separator rather than printing "0 kg"**, which
  next to a live colleague count reads as a failure. Bakery cycles print `ks` (units), the
  same split `orderQuantityLabel` uses one row above.
- `lib/plural.js` is the **one home** for `colleaguesLabel()` (1 kolega / 2-4 kolegovia /
  5+ kolegov). It was private to `GuestSubOrders.vue`; two screens now print it from two
  different sources, and two copies of a three-branch declension is how one of them ends
  up reading "3 kolegov".

**2. `FriendOrder.vue`'s cart lines are grouped by purpose and column-aligned.**
- ⚠ This **REVERSES 04 resolved conflict #10** (the prototype's flat list). What comes back
  is the grouping and one neutral `.badge.acc-o` header per purpose — the per-purpose page
  tints that the deleted `groupedCartItems` also carried do **not**.
- ⚠ **Group order is `availablePurposes`, not the cart's key order**, so the strip above and
  the cart below agree; a purpose no longer in the product list is **appended, never
  dropped**, or a line could go invisible while still being billed.
- Four columns: `.ln-name` (flex, ellipsis) · `.ln-qty` (26px, `1×`) · `.ln-size` (52px) ·
  `.ln-amt` (58px min, right). The fee line carries no header and no qty/size but keeps
  `.ln-amt`, so its figure stays in the same column. Verified by geometry, not text: every
  row 22px tall, all four columns sharing one x per column.
- ⚠ **`€` on the LINES only.** `.sum` ("Celkom: 28.50 EUR"), the success modal, the QR and
  `PaymentModal` all still say `EUR` — that is the figure the friend actually pays.
- ⚠ **The name is shortened by CSS, never in the data.** `overflow:hidden` +
  `text-overflow:ellipsis` + `white-space:nowrap` on a `min-width:0` flex item, with the
  full string kept in the DOM and in `title`. This is also what makes it safe against the
  RD-FO-2 hazard one screen up (a space-free 44-char name scrolled the document 263px
  sideways): unlike `overflow-wrap`, a clipped box cannot paint outside its row. Pinned at
  320px with an unbreakable name — clipped, one row, zero document overflow.
- Styles are a `<style scoped>` block in the view, **not** an addition to
  `friends-theme.css` (the `CatScrollArrow.vue` precedent — the theme is a byte-for-byte
  canon port with a numbered adaptation list this belongs to none of). Nothing below
  re-declares a property the theme's `(0,3,0)` `.cartbar .lines .ln` rule sets.
- ⚠ **`GuestOrder.vue` / `GuestOrderStatus.vue` / `GuestProductGrid.vue` still render the
  OLD flat cart footer with `EUR`** — the guest surface belongs to RD-GX-1 and was out of
  scope here. The two skins are now visibly different; do not treat the guest one as the
  reference when RD-GX-1 lands.

Specs edited: `order-cartbar.spec.js` (grouped assertions + a new long-name test) and
`portal-share-row.spec.js` (its `linkPayload` fixture now carries real `items`, plus a
cancelled row, and the `.tabbadge` locators became `share-row-count`). Verified locally:
those two files plus `order-shell`, `order-locked`, `order-product-card`,
`colleagues-panel`, `portal-fidelity`, `portal-cycles`, `mobile-no-h-overflow`,
`guest-host-view`, `guest-link`, `portal-session-boundary` — **157 passed**. The full suite
was not run for this change.

**Follow-up the same day — the cart fold's label absorbed the item count.**
`Položiek: N` is gone from the `.cartbar` meta row; the `<details>` summary now reads
**"Zobraziť položky v košíku (11 položiek)"** via `itemsLabel()` in `lib/plural.js`
(1 položka / 2-4 položky / 5+ položiek; 0 takes the genitive plural, "0 položiek", which
is correct Slovak and not a fallback).
- ⚠ The deadline row is now dropped **wholesale** when the cycle carries no
  `expected_date` — with the count gone it would otherwise be an empty flex row in the
  bar's vertical rhythm, and freeing that line is the whole point.
- The line it frees is spent on the control: the summary is `display:flex` (**full bar
  width**, so a thumb landing right of the label still opens the fold — the vertical
  padding alone would leave a narrow column), `min-height:40px`, 14.5px, `--ink` instead
  of the theme's `--ink-dim`, which at 13px dimmed read as a caption rather than a
  control. Measured 358×40 at 390px.
- Specificity here is **not** a cascade-order bet like `.cartbar` itself: the theme's
  `.cartbar details summary` is (0,3,0) and `<style scoped>` appends a data attribute to
  the last compound ⇒ (0,4,0), so it wins regardless of file order.
- ⚠ `getByText('Položiek: N')` was asserted in **four** friend-side spec files
  (`order-cartbar`, `order-locked`, `order-modals`, `order-product-card`) — all now read
  the summary's text instead, plus one assertion that `Položiek` has really left the meta
  row. The guest views keep their own `Položiek: N` footer (RD-GX-1's scope), so
  `guest-order-shell` / `guest-status-shell` are untouched and still pass.
Verified locally: those four files, **67 passed**, plus a 320px no-overflow check.

**Follow-up — decluttering the guest confirmation screen (`GuestOrder.vue`, 2026-08-12).**
Five product-decided cuts to `/g/:token`'s post-submit screen, frontend only.
- The rotated green `.badge.ok-solid` **"✔ Odoslané" is REMOVED.** It was the third
  statement of one fact: badge + the 34px "Objednávka je odoslaná" headline + the appbar
  subtitle "Objednávka odoslaná".
- ⚠ **`line-height:1.3` on the `h1.h-screen`, overriding the theme's
  `.h-screen{line-height:.95}` — not cosmetic.** This headline WRAPS on a phone and `.hl`
  paints a filled block plus a `0 4px 0` underline shadow, so at .95 the second line's
  block overlapped the descenders of "OBJEDNÁVKA JE" and clipped the underline. .95 is
  right for the single-line headlines the canon uses it for. Inline, because A9/A10 cannot
  beat a class rule that declares its own value. The `.sub` beneath went 10px → **20px**
  (the underline shadow eats 4px of any margin below the highlight).
- The copy-row label is now **"Na tomto odkaze uvidíte stav objednávky - uložte si ho!"**
  (verbatim from the product owner, plain hyphen) and the `.field-help` paragraph under it
  is **gone**. ⚠ Its second sentence was the ONLY on-screen explanation of the
  localStorage fallback (`api.js` writes `gorifi_guest_orders`, keyed by link token); the
  behaviour is unchanged but now undocumented **deliberately** — do not "restore" it.
  ⚠ `.field-lbl` is `text-transform:uppercase`, so this sentence renders as caps and wraps
  to two lines at 390px. Accepted.
- ⚠ Both removals are asserted in `guest-payment-modal.spec.js` as **absences**
  (`.badge.ok-solid` count 0, `.field-help` count 0, no `/Odoslané/` in the column) —
  new copy alone would let a revert pass. The headline's leading is asserted as
  **geometry** (the `.hl` box starting more than one font-size below the h1's top), which
  is the only way to see the overlap a text assertion cannot.
Verified locally: `guest-payment-modal` (11), `guest-order` + `guest-order-shell` +
`guest-invite-dead` (52) — **63 passed**, plus phone/desktop screenshots.

### `CartLineList.vue` — one home for every list of ordered coffee (2026-08-12)

Product decision: the colleagues' sub-orders on the host's screen and the guest's own
order summary must read exactly like the friend cart bar — grouped by purpose, one-row
names, quantity/size in aligned columns, `€` on every amount. Frontend only.

⚠ **`components/CartLineList.vue` is now the ONLY place this list is rendered**, on FIVE
surfaces: `FriendOrder.vue`'s cart bar, `GuestOrder.vue`'s cart bar AND its confirmation
sum card, `GuestOrderStatus.vue`'s item list, and `GuestSubOrders.vue`'s sub-order cards.
Before it they were five hand-rolled copies in **four different formats** — the host read
two of them on one screen. Extend the component; never fork it. Call sites map their own
row shape into `{ key, name, purpose, size, quantity, amount }` and own nothing else.

- ⚠ **Every value the component's CSS shares with the theme's `.cartbar .lines .ln`
  (0,3,0) is byte-identical, deliberately** — inside a cart bar the theme wins, outside it
  the component's rules are the only ones there are, and matching numbers is what makes
  the two cases indistinguishable. It deliberately does NOT declare `max-height` /
  `overflow-y` (the 170px scroll cap is the cart bar's alone; a list in a card must show
  every line) or `margin-top` (call sites pass their own, which falls through to the root).
- ⚠ **`line-height:normal` inside the component is load-bearing**: the `.ln-*` column
  classes are NOT in the theme's A10 list, so without it every line inherits preflight's
  1.5. The three call sites that used to carry their own `line-height:normal` inline (with
  measured +4.25px/+8.5px notes) delegate to it now.
- ⚠ **It renders `ul`/`li`**, so `li` counts in specs must be `li.ln` — the purpose header
  is an `li` too. Two shipped assertions counted bare `li` and read 3 for a 2-item order.
- ⚠ **The purpose header is a `.badge`, which collided with the sub-order card's "exactly
  ONE badge" rule** (§UC-KG-001/003, the paid/cancelled status flag). Fixed by scoping
  that assertion to a new `data-testid="sub-order-badges"` row — plus a second assertion
  that every *other* badge in the card is a group header, so the original rule is still
  enforced rather than merely relocated.
- ⚠ **`€` on item lines REVERSES 05 §UC-KG-003 item 2** ("EUR on totals only, item lines
  carry a bare mono column", from the prototype). A bare "15.20" was ambiguous precisely
  where it mattered: a colleague's lines sit in a card directly above a cart-bar total
  that belongs to a **different** order. Totals still say `EUR`.
- ⚠ **The amount uses an ORDINARY space before `€`.** A U+00A0 slipped in first and cost
  half an hour: Playwright normalises NBSP away for a STRING `toHaveText` but **not** for a
  REGEX one, so `toHaveText('9.04 €')` passed while `toHaveText(/^\d+\.\d{2} €$/)` failed
  on the same node. `.ln-amt` is `nowrap`, so NBSP bought nothing anyway.
- `GuestSubOrders`' precomposed `"2× Name — 250g"` string is gone. It existed because a
  sibling `<span>` could lose its separator to Vue's `condense` whitespace mode — a hazard
  that cannot arise once the size is a COLUMN. Its `variantText` now comes from
  `lib/guest-cart.js`, so `'unit'` reads "ks" instead of printing nothing.
- `lib/purposes.js` `purposeOrder(products)` gives the two guest screens the group order
  (`GuestProductGrid` computes it internally and never exposes it; `FriendOrder` passes its
  own `availablePurposes`). ⚠ **Deliberately NOT wired into either of those two copies**:
  they feed a `groupedProducts[activeTab]` LOOKUP whose keys fall back to `'Ostatne'`
  (no diacritic) while everything else in the app uses `'Ostatné'` — normalising there
  would make a purposeless product's tab select an empty group, i.e. silently hide
  product. Here the fallback only affects group ORDER, and unranked purposes are appended.
- `lib/guest-cart.js` `cartLines()` now carries `purpose` (presentation only — nothing
  prices or weighs by it).
- **NOT changed, and visible:** `GuestOrder.vue`'s cart bar still shows `Položiek: N` in
  its meta row with the small `<summary>`; the friend bar merged that into
  "Zobraziť položky v košíku (N položiek)" with a 40px hit target earlier the same day.
  The two bars now differ in that one respect.
Verified locally: `order-cartbar`, `colleagues-panel`, `guest-host-view`,
`guest-status-shell`, `guest-order-shell`, `guest-payment-modal`, `guest-status`,
`guest-order` — **~170 passed** — plus screenshots of all three restyled surfaces and
320px no-overflow checks.

**Follow-up — the guest cart bar matches the friend one (2026-08-12).**
`GuestOrder.vue`'s footer took the same change the friend bar took earlier the same day:
`Položiek: N` left the meta row for the `<details>` label
("Zobraziť položky v košíku (2 položky)", `itemsLabel`), the deadline row is dropped
wholesale when the cycle has no `expected_date`, and the summary is the same enlarged
control (`display:flex` full width, `min-height:40px`, 14.5px, `--ink`) via the same
(0,4,0) scoped override of `.cartbar details summary`. Measured 358×40 at 390px.
- ⚠ **The two bars still differ in ONE state, and it is by design.** The guest fold is
  `v-if="cartItems.length > 0"` (shipped rule, pinned), so an **empty guest cart shows no
  count at all** while the friend bar reads "(0 položiek)". Nothing is lost — the 0.00
  total and the disabled "Objednať" say it — and `guest-order-shell.spec.js` now asserts
  that absence rather than the old "Položiek: 0".
- ⚠ **`GuestOrderStatus.vue`'s EDIT bar keeps `Položiek: N`** and was deliberately not
  touched: it has no `<details>` fold to merge the count into. Its spec is unchanged.
Verified locally: `guest-order-shell`, `guest-status-shell`, `guest-order`,
`guest-payment-modal` — **73 passed**, plus screenshots at 390px/320px.

### The new domain, the tab brand, and the invite screen's restyle (2026-08-12)

**podpultovka.biz** serves the app alongside `gorifi.skolar.sk`. Wiring is in three
places and nowhere else: `server_name` in **both** `deploy/nginx-*.conf`
(`podpultovka.biz www.podpultovka.biz` on prod, `dev.podpultovka.biz` on staging),
and the `CORS_ORIGIN` default in `backend/src/index.js` — without the origin in that
allowlist every XHR from the new host 500s and the SPA renders a blank body (the same
failure mode the e2e harness note describes). TLS/DNS live outside the repo: the two
existing **Nginx Proxy Manager** proxy hosts each gained the new names plus a reissued
Let's Encrypt cert; `docs/deploy/nginx-proxy-manager.md` §5 is the runbook. ⚠ The
domain was first implemented as `.sk` and corrected to `.biz` — if a stray `.sk`
reference ever surfaces, it is that mistake, not a second domain.

**The tab is Podpultovka.** `index.html`'s `<title>` was still the Vite scaffold's
literal `frontend`; it is now `Podpultovka`, the favicon is `/coffee-cup.png` (was
`vite.svg`), and `FriendPortal.vue` sets `Podpultovka - Objednávky`.
- ⚠ **`GuestShareDialog`'s share-sheet title moves WITH `document.title`.** The
  UC-KG-006 freeze that kept it on "Objednávka Gorifi" was about *consistency* — the
  app must not introduce itself under one name in a message linking to a tab called
  another — so renaming the tab obliges renaming the payload. Both are pinned
  (`public-flow`/`modern-login` for the title, `share-dialog` for the payload).
- Admin screens still say "Gorifi Admin" — internal tool, still on the old skin.

**`InviteRegister.vue` (`/invite/:code`) is on the Podpultovka skin** — it was the
last friend-facing screen on shadcn `Card`/`Input`/`Label`/`Button`/`Alert`, and it is
the FIRST screen a new member ever sees. It has **no design-canon screen**
(`03-friend-login-portal.md:587` puts the route out of scope), so it is composed from
the two shipped public-screen precedents: the modern login's 480px branded column +
`.card` form, and the guest **g-dead** card for the terminal states.
- ⚠ **The Goriffee logo is GONE and `frontend/public/goriffee-logo.svg` is deleted**
  (product decision). This route was its only consumer app-wide. That also retires
  RD-DS-6's "colour treatment differs — design sign-off pending" residual: the asset
  needing sign-off no longer renders anywhere.
- ⚠ **`self-hosted-fonts.spec.js` had TWO tests pinning that logo** (an `h-12` decode
  check and an img-src-under-CSP check). Both were **retargeted, not deleted** — the
  value was never "a logo exists" but "an image this route renders actually decodes"
  (a CSP-blocked or 404 image is `complete` with `naturalWidth === 0`, which
  `toBeVisible()` misses). They now assert the chrome that replaced it plus a decode
  sweep over *every* image the route renders, and the CSP test additionally asserts
  `.app`'s themed background so a page that failed to mount cannot pass by rendering
  nothing. The route sweep at §1b is unchanged and still the generalizing assertion.
- Copy is **vy-form**: `Pozvánka od X` replaces "Pozval/a ťa" (a noun phrase needs no
  gender at all), "Tvoje meno" → labels only, "Popros priateľa" → "Požiadajte…".
- **No placeholders** on the three fields (the 2026-08-10 login decision, 81abbf9),
  and the email's "(pre zásielkovňu, voliteľné)" moved out of the label into
  `.field-help` — `.field-lbl` is `text-transform:uppercase`, so a parenthetical
  there renders as shouting.
- ⚠ **The success state is CENTRED (`flex-1`), not a top-aligned column.** Built
  top-aligned first and it was a headline stranded above ~1000px of empty halftone:
  g-confirm gets away with that composition only because a sum card, a line list and
  a payment button follow it. Terminal states with two lines of content use the
  g-dead centring. It carries no "Odoslané" badge, per the g-confirm declutter rule.
- ⚠ Both wrapping headlines carry inline **`line-height:1.3`** over
  `.h-screen{line-height:.95}` — the g-confirm lesson (`.hl`'s filled block plus its
  `0 4px 0` underline shadow overlap the line above at .95). Mutation-verified: the
  new spec's geometry test reddens when the override is removed, which no text
  assertion can do.
- ⚠ **`innerText` applies `text-transform`.** Three classes here are uppercase
  (`.h-screen`, `.badge`, `.field-lbl`), so a copy assertion read from `innerText`
  must be case-insensitive — `toContain('Pozvánka od')` fails against
  "POZVÁNKA OD …" while the copy is perfectly correct. `toHaveText` reads
  `textContent` and is NOT transformed, which is why element-level assertions can
  stay exact.
- New spec: `e2e/tests/invite-register-shell.spec.js` (9 tests). It provisions a real
  invite code via `GET /invitations/my-code` on a friend Bearer session — `friends.js`
  strips `invite_code` from every friend response, so that is the only route to one.
  ⚠ Running it repeatedly exhausts `abuseLimiter` (invite-code lookup, 40/window) and
  the *page* then renders its invalid state; raise `RATE_LIMIT_ABUSE_MAX` for repeated
  local runs, exactly as `RATE_LIMIT_AUTH_MAX` is raised for admin re-login.

**⚠ Running the suite locally: raise ALL FOUR rate-limit buckets, not just `AUTH`.**
The documented recipe raises nothing, and the failures it produces read exactly like
real regressions in code you just touched:
- `authLimiter` (20) — exhausted by admin re-login across several spec files;
  `share-dialog.spec.js`'s `refreshAdminToken` fails with `429 !== 200`.
- `abuseLimiter` (40) — the invite-code lookup. Exhausting it makes
  **`/invite/:code` render its INVALID state**, so an invite spec fails on copy that
  is perfectly correct, and a manual check of the page looks like a broken route.
- `guestReadLimiter` / `guestWriteLimiter` (300/60) — `guest-status.spec.js` alone
  runs enough guest writes that batching it with other guest files 429s ~15 tests.
- ⚠⚠ **KILL THE SERVER BY THE PID THAT OWNS THE PORT, and assert the port is free before
  restarting.** `pgrep -f node | head -1`-style killing takes a *stale* process while the
  one holding `:3997` survives; the replacement then fails to bind **silently**, and the
  suite goes on measuring **the code you just deleted**. This produced a false green
  during FUP-T12 — the fix was in the tree and the failures were still real.
  Use `kill $(ss -lptnH 'sport = :3997' | grep -oP 'pid=\K[0-9]+')`, then check
  `ss -ltn | grep -c ':3997'` is `0`, then start. Same class as the "confirm the port is
  free first" note above, but this is the failure it actually causes.
- ⚠ **`bcrypt-nonstring-shape.spec.js` CANNOT pass on the default `RATE_LIMIT_AUTH_MAX=20`** —
  it is the heaviest single consumer of `authLimiter` (~65 bucketed requests; each of
  its 12 change-password tests adds a login to prove the password is untouched). For
  this file the "raise all the buckets" recipe is a **hard requirement, not a
  convenience**, and the failure looks like a broken auth fix rather than a budget.
- `magicLinkLimiter` (10) — ⚠ **the newest, and the easiest to miss.**
  `magic-link.spec.js`'s shared-server describe issues **20** requests to
  `/api/magic-link/request`, and the limiter counts the 400s too, so from request
  11 onward you get `429` and ~10 red tests that read exactly like a real
  regression in the code you just touched.
Every one of these passes when its file is run ALONE, which is the tell. Start the
gate with `RATE_LIMIT_AUTH_MAX / RATE_LIMIT_ABUSE_MAX / RATE_LIMIT_GUEST_READ_MAX /
RATE_LIMIT_GUEST_WRITE_MAX / RATE_LIMIT_MAGIC_MAX` raised — `rate-limit.spec.js`,
`rate-limit-isolation.spec.js` and `magic-link-rate-limit.spec.js` then self-skip
(they need LOW limits), which is exactly the documented "4 skipped".
⚠ Also: pipe the run to a FILE, never `| tail -N`. A `tail -25` keeps the summary
(which is honest about pass/fail) but discards every `✘` line above it, so a run
with failures is indistinguishable from a clean one at a glance.

**⚠ `order-fidelity.spec.js`'s cartbar-`<details>` test was STALE IN PRODUCTION.**
Commit `113d261` (the cart fold absorbing the item count) deliberately overrode the
theme's `inline-flex` summary with `display:flex; min-height:40px`; that spec still
asserted the canon `inline-flex` and a 24px `<details>`, and the change shipped to
prod with the failure unnoticed because — as its own CLAUDE.md note says — the full
suite was not run for it. Retargeted, not deleted: the `line-height:normal` counter
it exists for is asserted first and unchanged, the geometry now pins the **40px hit
target** the decision bought (mutation-verified: dropping the override reddens it),
and `CANON.cartbarDetails` is gone in favour of a separate `SHIPPED` constant so a
prototype number and a deliberate divergence can never again be confused.
⚠ One structural consequence is now pinned too: a **block-level** summary's 8px top
margin **collapses** with the `<details>`'s own, where the canon's inline-level one
could not — so `detailsH === summaryH` today, and giving `.cartbar details` any
padding or border would silently add 8px back to the bar's height.

### ⚠ A12 — iOS zoomed the whole app in after login (2026-08-12, reported from prod)

Mobile Safari zooms the viewport IN when a text control with a computed
`font-size` **under 16px** is focused, and **does not zoom back out on blur** — so
one tap in the login field left every subsequent screen magnified for the rest of
the session (appbar chip and logout glyph clipped off the right edge, ticker cut
mid-word, cycle-list gear unreachable). The canon's `.inp` is **15px**, i.e. exactly
1px inside the trigger; `.inp.mono` is 13px.

- Fixed as **adaptation A12** in `friends-theme.css` (the 4th addition to the ported
  stylesheet), gated on **`@media (pointer: coarse)`** so desktop keeps the canon
  15px — the deviation is 1px, only on devices that have the bug. The gate is
  deliberately **not** `max-width`: an iPad in landscape is 1024px wide and zooms
  just the same.
- ⚠ **`.inp.mono` needs its own line inside the block.** It is (0,2,0) against
  `.inp`'s (0,1,0) — `:where()` contributes nothing — so it would keep 13px and keep
  zooming. It has no call site today, so that line ships as a no-op on purpose.
- ⚠ **The fix must NEVER be `maximum-scale=1` / `user-scalable=no`**, which is what
  most search results suggest: it removes pinch-zoom for everyone (WCAG 1.4.4) on the
  one screen where someone who cannot read a password most needs to magnify.
  `ios-input-zoom.spec.js` asserts the viewport meta contains neither.
- ⚠ **The zoom itself is NOT reproducible in this suite** — no engine here implements
  it and the gate runs Chromium. The spec measures the *condition* it keys on
  (computed font-size under `pointer: coarse`, which Chromium reports under touch
  emulation), plus the desktop counter-assertion that the 15px canon is untouched.
  A test watching `visualViewport.scale` would be silently vacuous.
- Remaining instances NOT fixed (admin-only, still old skin): the `text-sm` (14px)
  `<textarea>`s in `CycleDetail.vue` and `AdminBakeryProducts.vue`. Same bug class;
  out of scope for a friend-surface fix.

**⚠ THE LOCAL GATE IS UNRELIABLE ON A SMALL BOX, and it produces failures that read
exactly like regressions.** This host is 4 GB / 2 cores: Chromium dies with
**SIGSEGV** ("worker process exited unexpectedly", `Target crashed`, bash exit
**139** — which also silently truncates an `&&` chain, so a build never runs and the
test then measures a STALE `backend/public`), and the long walkthrough specs cross
their 30s timeout under memory pressure. A **different set** of tests fails on every
run — that non-determinism is the tell. Confirm any suspicious failure by running its
file ALONE, two or three times, before believing it.

### ~~Noto Sans Condensed on the product description~~ — SUPERSEDED (2026-08-18): the face is Figtree now

**Product decision 2026-08-18 (owner, from prod screenshots): `.pspec`/`.pnotes` and
the portal cycle card's date/plan rows use the STATUS BANNER's typeface — Figtree,
the body face — bold (`description1` / date) and regular 400 (`description2` /
plan).** That left Noto Sans Condensed with **zero consumers**, so the whole face
was removed: `--font-cond`, the four `@font-face` blocks in `fonts.css`, the two
700-cut preloads in `index.html` (a preload with no consumer logs "preloaded but
not used" on every route) and all four `noto-sans-condensed-*.woff2` files. The
condensed tracking (`.005em`) went with it; **sizes, colours and line-heights kept
the 2026-08-13 values** (card 14.5/14px, portal 14/13.5px — so `portal-fidelity`'s
22.95px leading pin is unmoved). The portal rows now declare NO font-family at all
(inherited body face); the plan row also lost its `font-weight` (400 is the
default). Specs retargeted with it: `product-desc-font.spec.js` (rewritten —
Figtree 700/400 computed table, `ls: 'normal'`, plus a "no font preloads remain +
no stylesheet asks for Noto" test), `order-product-card.spec.js`,
`portal-cycles.spec.js` (weight 500→400), and `self-hosted-fonts.spec.js`'s
exact-set `FAMILIES` ledger — which is what forces this edit in either direction —
back to the three families, with a Figtree 700 probe replacing the two Noto ones.
Most of the section below is HISTORY now; still true and load-bearing: the
subsetting/latin-ext lessons (if any face is ever added again), the
`document.fonts.load` catch-wrapping, the `gotoFriendCard` portal-entry rule, and
the `.mono`-left-the-card pins.

Two lines under the badges in a **coffee** product card change typeface — a
frontend-only, typography-only change (`git diff -- backend/` is empty):

| line | field | was | now |
|---|---|---|---|
| spec | `description1` | `.sub` Figtree 13px `--ink-dim` | **`.pspec`** Noto Sans Cond **700**, 14.5px, lh 1.25, ls .005em, `--ink` |
| notes | `description2` | `.mono` Courier Prime 12.5px `--ink-faint` | **`.pnotes`** Noto Sans Cond **500**, 14px, lh 1.3, ls .005em, `--ink-dim` |

- **`--font-cond`, `.pspec` and `.pnotes` are a CANON SYNC**, not a local invention:
  the design project's own `friends/theme.css` carries all three verbatim (fetched and
  compared, 2026-08-13). So they are ported into `friends-theme.css` like every other
  rule there — **not** as a numbered adaptation (~~the list still ends at A12~~ —
  **superseded: PI-T2 added A13**, the `portal2.css` canon port for the drawer/appbar;
  see the A13 block at the end of `friends-theme.css` and `docs/learnings/10-portal-ia.md`
  §A13. This file is what CLAUDE.md's index tells the next implementer to read BEFORE
  touching the theme, so the number has to be right here.)
- ⚠ **The canon also moved `--font-mono` to `'Space Mono','Courier Prime',monospace`.
  That is NOT ported.** Space Mono is not self-hosted here, so the stack would fall
  straight through to Courier Prime and render identically while implying a face we do
  not ship. The brief scopes the change to two lines and says mono stays.
- ⚠ **Only the COFFEE card changed.** The bakery card renders the same two columns
  with a *different mapping* — `description2` is a subtitle beside the name and
  `description1` a plain line — so it keeps `.sub`. Admin views (`CycleDetail.vue`)
  also render these fields and are deliberately untouched (old skin).
- The notes line **loses `.mono` on purpose** (it was the least readable text on the
  card). Mono stays on dates, prices, IBANs and references — pinned by asserting zero
  `.mono` inside a product card *and* that `.cartbar .deadline` still has it, so
  "mono left the card" cannot be satisfied by mono leaving the screen.

**Self-hosting (four new files, 99,192 B total).** OFL 1.1, and the prod CSP is
`font-src 'self' data:` — a CDN is blocked outright (RD-DS-6). Two cuts only, 500 and
700, no italic, no variable font.
- ⚠ **The latin-ext range here is NARROWER than Google's, and is declared exactly as
  shipped** — the one place this file departs from "preserve Google's ranges verbatim",
  because these files are subset from the handoff TTFs rather than being Google's own
  subset. Noto's Latin coverage is enormous: at Google's literal latin-ext range each
  weight came to **62.6 KB**, the excess being IPA Extensions (U+1D00-1DBF), Latin
  Extended Additional (U+1E00-1E9F, i.e. Vietnamese) and Extended-D (U+A720-A7FF).
  Restricting to U+0100-024F + punctuation/currency gives **28.1/28.7 KB**. Declaring
  the narrower range is the load-bearing half: a codepoint outside it now falls
  through to `'Noto Sans'` → sans-serif instead of fetching a file with no glyph.
- ⚠ **Slovak is in latin-ext, not latin** (carons are U+0100-017F). Shipping only
  `latin` breaks "mliečna čokoláda" **mid-word**. Both subsets ship for both cuts.
- **`self-hosted-fonts.spec.js`'s exact-set `FAMILIES` assertion is what forced the
  ledger update** — a face cannot arrive here without one. That is its whole purpose;
  `PROBES` gained both cuts, so latin AND latin-ext are load-verified per weight.
- **Preload: the 700 cut only, both subsets** (~50 KB), per the brief's no-FOUT
  criterion. Deliberately not all four — this is fetched on every route including the
  portal, where no card exists. Measured: **no "preloaded but not used" console
  warning** on either the order page or the portal. `crossorigin` is required even
  same-origin, or the browser fetches each file twice.

**Verified:** every briefed value asserted as *computed* style on both the friend and
the guest card (06 §UC-GX-002 pixel-identical), both acceptance strings on **one** line
at 390px — including `Honey Co-Fermented Pink Bourbon · SCA 86`, which the brief only
required to fit in two — and the diacritic check is mutation-proved: removing
`noto-sans-condensed-500-latin-ext.woff2` reddens exactly one test with
"500|latin-ext rendered in the FALLBACK face (brand 316.4 vs fallback 316.4)".
⚠ That check needed **two** `document.fonts.load` call sites wrapped in a catch —
unhandled, a missing subset surfaces as an opaque `page.evaluate: NetworkError` from
whichever helper ran first, masking the assertion that names the broken subset.
⚠ Two shipped assertions in `order-product-card.spec.js` pinned the OLD classes
(`.sub` / `.flex-1 .mono`) and were retargeted; the second (`unbreakable product
name`) merely needed `.mono` → `.pnotes` as its probe.
⚠ `gotoFriendCard` must enter via the portal card — a direct `page.goto('/cycle/:id')`
races FriendOrder's session restore and bounces to `/`, which cost a debugging round.

Batch after this work: **106 passed** across the ten affected files.

**Follow-up the same day — the portal cycle card's date and plan rows.** Product
decision: extend the condensed face to `FriendPortalSession.vue`'s cycle card — the
date under the cycle name is **Noto Sans Cond 700**, the `plan_note` block **500**.
Sizes, colours and spacing are unchanged (12px, `--ink-dim` / `--ink-faint`); only the
family and weight move, so no new woff2 and no new token.
- ⚠ **`.mono` is REMOVED from both rows, not overridden.** An inline `font-family`
  would have won while leaving the class in place, and several specs read `.mono` as
  "this is the mono face". Consequence to keep in mind: `.mono` is what used to carry
  A10's `line-height:normal` on the date row — `.sub` stays there and covers it, and
  the plan block's inline `line-height:1.7` was already the only declaration (20.4px,
  still pinned).
- ⚠ **FOUR shipped assertions located these rows by class** — `.mono.sub` and
  `.mono` **nth(1)** in `portal-cycles.spec.js`, `.mono.sub` / `.mono:not(.sub)` in
  `portal-fidelity.spec.js` (the line-height invariant AND the 320px hostile-text
  `overflow-wrap` test). All four now use `data-testid="cycle-date"` /
  `"cycle-plan"`, added for exactly this reason. The `nth(1)` one was the dangerous
  case: with the class gone it would not have errored but silently re-pointed at the
  archive rows' money column, which IS still `.mono`.
- The face is now asserted (family + weight), not just relocated — otherwise the
  change would have been a locator rename with nothing pinning it.
Verified: 64 passed across `portal-cycles`, `portal-fidelity`, `portal-share-row`,
`portal-appbar`, `mobile-no-h-overflow`; zero overflow at 390px and 320px.
- **Sizes bumped the same day** (both rows read too small in the condensed face):
  date **12 → 14px**, plan **12 → 13.5px**. The plan stays *below* the date so the
  hierarchy is carried by size AND weight, not weight alone. ⚠ Two assertions moved
  with it: `portal-cycles`' `font-size` on the plan, and — less obviously —
  `portal-fidelity`'s **computed line-height**, since the row's leading is the inline
  unitless `1.7` (12 × 1.7 = 20.4px → 13.5 × 1.7 = **22.95px**). A size change on any
  row whose leading is a multiplier moves that pin too.



### FUP-T24 — the kg display rule gets one home, and "trailing zeros stripped" turns out to be nobody's code (2026-09-20)

`Math.round(g/10)/100` had **four hand-written copies and no home**: `FriendOrder.vue:458`
(the stock bar's „Zostáva X z Y"), `GuestProductGrid.vue:177` (the same bar on the public
guest grid and the guest edit page), `FriendPortalSession.vue:974` (the cycle card's
„N kolegovia · X kg") and `Distribution.vue:579` (the board's plan lines and per-party
„{n} pol. · X kg"). CLAUDE.md stated the rule **without an address** — the shape corrected
three times this week (`helpers/payment.js`, `helpers/delivery.js`, `e2e/helpers/copy-sweep.js`).
DP-T5 added the fourth copy **deliberately, with a pointer**, rather than refactor three
shipped views under a board row: the right call for that row, the wrong steady state.
One home now: **`frontend/src/lib/kg.js kgLabel(grams)`**, beside `lib/plural.js`.

- ⚠ **The four were not identical, and the difference was the null guard, not the maths.**
  Three read `(grams || 0)`; `FriendPortalSession` read `summary.grams` bare, because its
  caller returns `''` two lines earlier (`if (!summary.grams) return ''` — „ · 0 kg" beside
  a live colleague count reads as a failure, not as "no weight yet"). The guard stayed at
  that call site — it is that row's **copy** decision, not part of the rule — and the one
  home took the fail-closed `|| 0` the three grids always had, so `null`/`undefined`/`NaN`
  render „0 kg" and never „NaN kg" beside a price.
- ⚠⚠ **"With trailing zeros stripped" is TRUE and NOTHING STRIPS ANYTHING.** No code in any
  of the four removed a zero. It is `Number#toString` emitting the shortest representation
  that round-trips, so a two-decimal value can never come out „1.50" or „1.00". Checked
  exhaustively over 0–200000 g: no trailing zero, no float artifact (the rounded numerator
  is an integer, so `/100` is exact to the shortest repr). **The property survives only
  while the number goes straight into a template literal** — hand the raw number to a call
  site and one `toFixed(2)` prints „1.00 kg" on that screen alone. That is why `kgLabel`
  returns the **whole string, unit included**, rather than a number: the invariant is
  enforced by the signature instead of by four authors remembering it. CLAUDE.md's bullet
  now says this, with the address.
- ⚠ **The fifth surface is a DIFFERENT rule and was left alone.** `CycleDetail.vue:1744`'s
  catalog badge („max {limit}") switches **unit at a threshold**: `>= 1000` divides by 1000
  with **no rounding**, below it prints raw grams with **no space** („500g"). 1234 g reads
  „1.234 kg" there and would read „1.23 kg" here — different output, different audience (an
  admin reading back the limit they typed), different contract. Folding it in would silently
  change an admin screen. Two rules, two homes — the mistake avoided twice already this week.
- ⚠ **THE GUEST GRID WAS UNPINNED, and that is the finding, not a detail.** Pinning the four
  surfaces first showed `order-product-card.spec.js` (friend bar), `portal-share-row.spec.js`
  (share row) and `distribution-board`/`distribution-rows.spec.js` (board) each assert the
  rendered kg string — while the **public guest page**, the one surface with no account
  behind it, had only `guest-order-shell.spec.js`'s `stock-label` → `'Vypredané'`, i.e. the
  branch that never calls the formatter. A shared formatter with three of four surfaces
  pinned is a formatter that can go wrong quietly on the surface strangers see. One test
  added there („Zostáva 0.5 kg z 0.5 kg" → „0.25 kg z 0.5 kg"), which also pins the
  no-trailing-zero case on that grid.
- ⚠ **Mutation-proven in both mutations, and the first one taught something.**
  `/10)/100` → `/100)/10` reddened order-product-card (×3), portal-share-row (×3),
  distribution-board (`plan-line-packeta` „0.25 kg" → „0.3 kg") and the new guest test —
  but **distribution-rows:302 passed**, because its fixture is a whole kilo and 1000 g is a
  **fixed point** of that particular mutation („1 kg" either way). A second mutation
  (`/5)/100`) reddened it („3 pol. · 2 kg"). A kg assertion written only on a round kilo is
  half a pin; the interesting values are 250 / 1250 / 1500.
- Gate: `node --check` + `vite build` clean; targeted **131 passed / 0 failed / 0 skipped,
  EXIT 0** (`order-product-card`, `portal-share-row`, `distribution-board`,
  `distribution-rows`, `guest-order`, `portal-fidelity`, `order-cartbar`,
  `guest-order-shell`) plus `guest-status` 20/0/0 for the grid's second consumer.
  ⚠ `portal-fidelity.spec.js` and `order-cartbar.spec.js` were named in the row as kg
  renderers — **neither contains a single kg assertion** (checked, not assumed); the real
  pins are the four files above.

**Orchestrator verification and review (same day).** Independent gate on a fresh template
copy, all five limiter maxima at 100000: **155 passed / 0 failed / 0 skipped, EXIT 0** across
nine specs (the four surfaces' pins plus `portal-cycles`, `colleagues-panel`,
`guest-status-shell`, `guest-status`). The mutation claim was re-proven from scratch rather
than taken from the report: `/5)/100` in the one home reddens **all four surfaces** — 12
failures across 5 files. Review verdict **approve**, four minors, all acted on:

- ⚠⚠ **A spec line was about to order copy #5 — at 1000× the wrong scale.** The
  expression-grep that found `08-` and `16-distribution-pipeline.md` **misses the specs that
  state the rule in WORDS**. Three did: `13-coffee-passport.md:568`, `18-portal-information-
  architecture.md:310`, `04-friend-order.md:410`. 13's line tells a future implementer to
  format `total_kg` "by the house kg rule … never `toFixed(2)`" — and `total_kg` is in
  **KILOGRAMS** (`helpers/analytics.js variantToKg()` returns `0.250` for a 250 g bag) while
  `kgLabel` takes **GRAMS**, so the obedient reading prints a number 1000× too small. 18's
  drawer row is spelled „… · {kg} kg", which with `kgLabel` renders „0.25 kg kg". All three
  now carry the address **and** the unit warning. **The lesson is about the sweep, not the
  specs: a rule can be restated without its expression, so grep the CLAIM as well as the code.**
- **The half-pin is now closed, not just noted.** `distribution-rows.spec.js` was still the
  only assertion on `Distribution.vue`'s `contentLine()`, and still on a whole kilo. Guest B
  now orders 3×250 g, so the party reads **„3 pol. · 1.25 kg"**. Re-proven both ways: green
  at 11/11 unmutated, and the scale-preserving `/100)/10` — the exact mutation it survived
  before — now **reds it**. Sweep of every other kg assertion in the suite: `order-product-card`
  (1.25/1/5/0.25), `portal-share-row` (0.75/0.25/1.5/3), `distribution-board` (0.25/1.5) and
  the new `guest-order-shell` (0.5/0.25) all carry a non-integer value; no other assertion
  shares the weakness.
- **`CycleDetail`'s badge has its own pin** — `catalog-admin.spec.js:3493/:3503` asserts
  „max 2 kg". So a later attempt to fold the fifth surface into `kgLabel` reddens a test
  instead of silently changing an admin screen. Two rules, two homes, **both pinned** — which
  is what makes "leave it alone" a decision rather than an omission.
- **`FriendPortalSession.formatKilos()` (`toFixed(2)`, the „Objednané ·" badge) stays
  home-less on purpose** — different contract, one copy, pinned by `portal-cycles.spec.js:479/:488`.
  It now sits six lines from a `kgLabel` call with only a comment between them; that comment
  is load-bearing.
- **My own row text was false and is struck in the row.** The acceptance criteria I wrote
  named `portal-fidelity`, `guest-order` and `order-cartbar` as kg renderers. **None of the
  three asserts a kg label** — the first two contain no `kg` substring at all, and
  `guest-order` has it only in prose and in `variant: '1kg'` API payloads. Second time this
  session that a premise I wrote into a backlog row went unchecked against the code it named
  (the first: "one door, not three" on the cancelled-after-hand-over seam, DP-T4). **A premise
  in a backlog row is a claim, and it inherits none of the verification the row demands.**
