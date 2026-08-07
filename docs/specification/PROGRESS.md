# Gorifi — Friends portal + guest flow redesign ("Podpultovka Neobrutal PP") — Backlog

Task definitions live in **`docs/specification/02…06-*.md`** (UC IDs are those files'; the design
bundle is `docs/design/friends-portal-redesign/`, its `theme.css` + 17 screenshots are the fidelity
reference). This file is the dependency-ordered build plan derived from them.

**Legend** — `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked.
One row = one shippable pipeline run (`/next-task`). **Top-to-bottom = dependency order** — never
start a row before the rows above it that it depends on. `⚠` marks a cross-task seam: what an earlier
task deliberately left unfinished and which later row completes it. ` · model=heavy` tags slices worth
a stronger model (money paths, state machines, dense pin surfaces); untagged rows inherit the session model.

> **Stack note:** Vue 3 + Vite + Tailwind 3, plain JS. Frontend-only re-skin — **no backend, schema
> or API change of any kind**; every GSO/auto-save behavior contract in CLAUDE.md still holds.
> The e2e harness already exists (`e2e/`, Playwright, target-agnostic via `BASE_URL`) at a
> **238 passed / 3 skipped** baseline — no harness task needed. Every row must leave the suite green;
> the ONLY sanctioned edits to existing specs are: 2 in `guest-link.spec.js` (RD-KG-2) and 5 listed
> in 06 §UC-GX-011 (spread over RD-GX-2/3/4). Anything beyond that list is a regression.
> Admin invariance is a hard gate on every row: no `pp-*`/`neo/`/theme classes under admin views.

> **Open product decisions** (all have spec-recorded defaults; none block a row): index.html
> title/lang/favicon rebrand (02/03 — default: leave "Gorifi"); positive-balance styling (03 —
> default: green mono); transactions modal restyle (03 — default: keep as-is); appbar subtitle
> "name · code" source (04 — default: name only); locked-cycle Zaplatiť shortcut for unpaid friends
> (04 — default: keep hidden, money touchpoint); share-sheet title "Objednávka Gorifi" → Podpultovka
> (05); `13-shot.png` duplicates the cancelled state — verify the editable status state against the
> live prototype (06).

---

## 0. Design system foundation (02) — inert until screens apply `.app`

- [ ] RD-DS-1  friends-theme.css scoped port (adaptations A1–A8) + shadcn `--ui-*` token de-collision + Google Fonts + Tailwind `pp` palette/fonts — `02 §UC-DS-001..005,013,014` ⚠ applies `class="app"` to NO view — each screen row below starts by mounting it; index.html title/lang stays untouched (open decision); `.pimg` no-photo fallback OPEN is closed by RD-FO-2. Acceptance: before/after screenshots of `/` and admin pages identical, suite 238/3, `vite build` green.
- [ ] RD-DS-2  neo/ primitives: NeoIcon (14 glyphs, verbatim ui.jsx paths) + BrandChrome (appbar/hazard/static ticker ×3) — `02 §UC-DS-006,007` ⚠ per-screen ticker copy + slot content supplied by consuming rows; e2e smoke deliberately deferred to RD-FL-2 (module 03 is the primitives' regression net).
- [ ] RD-DS-3  neo/ form primitives: NeoStepper (incl. `decTestid/valTestid/incTestid` + `incDisabled` props) + NeoCheckbox (incl. `disabled`) + snapTab helper + money convention (`fmtEur`, Courier Prime) — `02 §UC-DS-008,009,012` ⚠ stepper has NO max — stock ceilings stay in views; testid pass-throughs exist for RD-FO-2/RD-GX-1's pinned e2e hooks; NeoStepper/snapTab e2e smoke lands with RD-FO-1/2.
- [ ] RD-DS-4  neo/ overlay primitives: NeoModal (Teleport shell, scrim/Esc/`closable:false`, scroll-lock, focus return, one-at-a-time) + NeoCopyRow (2 s "Skopírované!" flip, timer restart, `valueTestid`) — `02 §UC-DS-010,011` ⚠ shell only — every concrete modal is composed by later rows; NOT radix (`ui/dialog` stays admin-only); `valueTestid` consumed by RD-KG-2.

## 1. Friend login + portal (03) — first consumer, primitives' regression net

- [ ] RD-FL-1  FriendPortal scaffold: `.app` root + BrandChrome in all 3 states + legacy-login pin (untouched branch) + loading/error restyle — `03 §UC-FL-001,003` ⚠ legacy/transition login + voucher modal deliberately keep transitional look (out of scope); `gorifi_friend_auth` localStorage shape is written directly by 3 e2e suites — byte-identical.
- [ ] RD-FL-2  Modern login (Kto klope?, eye-toggle, remember-me, invite explainer) + forced password-change on NeoModal + new modern-mode e2e — `03 §UC-FL-002,012` ⚠ first real e2e smoke for BrandChrome/NeoModal/NeoCheckbox/NeoIcon (02's deferred obligation); modern specs must provision `auth_mode='modern'` and restore legacy — the shared seed stays legacy.
- [ ] RD-FL-3  Authenticated appbar (name/uid/pencil/Pozvať chip/logout) + FriendBalanceCard restyle — `03 §UC-FL-004,005` ⚠ appbar taps are triggers for RD-FL-6/7 (modals stay old-skin until then); `BalanceBadge.vue` NOT modified (shared with admin) — card renders its own 3-state span.
- [ ] RD-FL-4  Cycle list: header + gear trigger + cycle cards (badges, plan block, folded "Objednané ·" qty) + archive fold — `03 §UC-FL-006,008` · model=heavy ⚠ card ships WITHOUT the share row — RD-FL-5 adds it and only then is the `div.p-4` pin (guest-link.spec.js `cardFor()`) fully satisfied — keep the two rows adjacent; locked cycles stay clickable (read-only view is 04's).
- [ ] RD-FL-5  Share row + colleague-count badge: seq-guarded per-open-cycle `GET /guest-links/cycle/:id` (existing endpoint, frontend-only addition — the module's ONLY script change) + GuestShareDialog entry contract — `03 §UC-FL-007` ⚠ dialog INTERNALS are RD-KG-2's — wire only `:open/:cycle-id/:cycle-name` + `@click.stop`; visible "Zdieľať" + `aria-label="Zdieľať s kolegami"` keeps guest-link.spec.js unmodified.
- [ ] RD-FL-6  Profile modal on NeoModal: read-only uid/username row, name/Packeta fields, password-change fold, errors move into modal body — `03 §UC-FL-009` ⚠ `saveProfile` side-effects preserved (appbar name from RD-FL-3 updates immediately).
- [ ] RD-FL-7  Subscription modal (NeoCheckbox rows) + invite modal (NeoCopyRow) — `03 §UC-FL-010,011` ⚠ NeoCopyRow ABSORBS the view's `copyInviteLink()`/`inviteCopied` — delete once unused; never hardcode the prototype's demo host.
- [ ] RD-FL-8  Module 03 closeout: pinned-selector audit, 378/1180 px fidelity vs 01/02/17-shot + live prototype modals, 320 px eyeball, admin invariance re-assert — `03 §UC-FL-013`

## 2. Friend order (04) — biggest module; tab shell gates module 05

- [ ] RD-FO-1  FriendOrder shell: `.app` chrome + status banners + main-switch `.tabgroup` (pinned testids, v-show panels, badge from `summary` emit) + sticky `.cat-tabs` (`data-testid="purpose-tabs"`, snapTab) — `04 §UC-FO-001..004` · model=heavy ⚠ `#panel-guests` built as v-show SHELL only — RD-KG-1 cannot start before this row; badge computed here and never re-owned by 05; carries the appbar-subtitle OPEN (default: name only); snapTab regression spec lands here.
- [ ] RD-FO-2  Product cards: coffee card + `.vbox` variants + stock bar (kg display, gram math untouched) + bakery card — `04 §UC-FO-005..007` ⚠ closes RD-DS-1's `.pimg` OPEN: no-photo = bare gradient frame; product name stays a `<h3>` heading for `getByRole('heading')`; NeoStepper e2e smoke lands here.
- [ ] RD-FO-3  Sticky `.cartbar`: deadline/count/`paymentTotal`, actions, inline dirty warnings (dismissable ✕), flat cart lines behind `<details>` — auto-save matrix preserved verbatim — `04 §UC-FO-008,009` · model=heavy ⚠ Zaplatiť opens PaymentModal with pinned props — modal internals are RD-GX-2's, do NOT touch PaymentModal.vue here; page-level warnings move into the cartbar.
- [ ] RD-FO-4  Modals: Spôsob prevzatia (4-scenario matrix + RadioRow + save-as-default via `updateFriendProfile`) + Hotovo! + Zrušiť confirm + leave guard — `04 §UC-FO-010..013` · model=heavy ⚠ success modal carries NO payment-reference row (reference lives only in the Platba modal → RD-GX-2); RadioRow pattern liftable by RD-GX-1's checkout — lift, don't re-invent; cancel copy must stay true (colleagues' sub-orders survive — assert it).
- [ ] RD-FO-5  Locked state (f-order-locked) composition + module 04 closeout: fidelity vs 03/07/08/17-shot, pinned-selector audit, admin invariance — `04 §UC-FO-014,015` ⚠ Kolegovia LOCKED content look is RD-KG-1's — verify shell + amber badge flip only; carries the locked-Zaplatiť OPEN (default: keep hidden).

## 3. Colleagues panel (05)

- [ ] RD-KG-1  Kolegovia panel restyle: share row, summary heading, `.suborder` cards (fold/badges/big-green Odovzdané via NeoCheckbox `disabled`-capable/Odstrániť `.confirmbox`/cancelled recomputed Σ), empty + locked states, additive `rows` field on `summary` emit — `05 §UC-KG-001..005,007` · model=heavy ⚠ RD-FO-1's badge keeps consuming `count`/`pendingDelivery` — do not re-gate it on `rows`; loadSeq/rowSeq/ready-gate script contracts verbatim; zero e2e edits — guest-host-view.spec.js runs unmodified; paid-409 renders verbatim in a danger banner with confirmbox kept open.
- [ ] RD-KG-2  GuestShareDialog recomposed onto NeoModal/NeoCopyRow (create/deactivate/regenerate + warn banner + inline confirm, native share conditional) + the 2 authorized guest-link.spec.js edits (inputValue→textContent for the copy-row `.val`) — `05 §UC-KG-006,007` ⚠ component API (`open/cycleId/cycleName`, `update:open`) frozen — RD-FL-5's and RD-KG-1's entry points need no change; keep `role="dialog"` + Esc so the race-guard spec stays green; deletes the bespoke execCommand fallback (NeoCopyRow owns copy); share-sheet title OPEN (Gorifi → Podpultovka).

## 4. Guest flow (06)

- [ ] RD-GX-1  g-order restyle: guest brand header + hero `.card.hl` + GuestProductGrid neo restyle (pixel-identical to RD-FO-2's cards) + sticky cartbar + checkout modal — `06 §UC-GX-001..003` · model=heavy ⚠ grid is shared with status edit mode (GSO-T4 one-home rule) — status screen inherits the neo grid early, acceptable interim inconsistency; zero e2e edits in this slice; g-confirm + dead-link stay old-skin here (RD-GX-2/4); submit payload byte-identical, no auth headers.
- [ ] RD-GX-2  Platba modal restyle (PaymentModal.vue — props API frozen) + g-confirm screen + payment-reference relocation into the modal — `06 §UC-GX-004,005` ⚠ RD-FO-3/4's friend flow INHERITS this restyle with no change on its side; carries sanctioned e2e edits #2(order-half)/#3/#4; bysquare/qrcode payload byte-identical — a scanned QR must resolve unchanged.
- [ ] RD-GX-3  g-status restyle: four read states (pills / paid-frozen / locked warn / cancelled terminal) + edit mode (reuses neo grid) + shared cancel-confirm (3 entry points; only literal `items: []` cancels) — `06 §UC-GX-006..008` · model=heavy ⚠ carries sanctioned edits #2(status-half)/#5; server flags `editable`/`items_editable` drive everything incl. undefined fallback; invite CTA shows in all four states when `invite_request.available` (server flag wins over prototype).
- [ ] RD-GX-4  Invite CTA restyle (GuestInviteRequest, 4 states, "Chcete si objednať sami?") + g-dead 3 variants + status-404 card + module 06 verification sweep — `06 §UC-GX-009..011` ⚠ carries sanctioned edit #1 (guest-lead-capture.spec.js regex); closes the effort: all 7 sanctioned e2e edits spent, `git diff --stat backend/` empty, api.js + guest-cart.js unchanged, full fidelity pass vs 09–12/14–16-shot + live prototype (13-shot is a duplicate of 15 — editable state compares against the prototype).

---

## Log
