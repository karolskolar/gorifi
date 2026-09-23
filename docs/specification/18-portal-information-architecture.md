# 18 — Portal information architecture: landing = current offer, menu, explainer, history, balance, profile

> Scope: The friend portal's information architecture, replacing module 03's
> "cycle list" landing (F1 + F2 + F3.3 of the roadmap, bundled by PO decision — roadmap
> §9 item 7). Seven areas: (a) the landing at `/` renders the **current round's product
> grid** directly, in one of three states — *open* (status line + cart), *closed*
> (read-only grid behind a dismissible state modal, then a slim banner), *locked* (own
> order card + „Kde je vaša káva“ timeline + next-round banner, grid read-only);
> (b) a **hamburger drawer** replaces every appbar control except the brand and the
> **Pozvať** chip; (c) **Moje objednávky** (history) and **Zostatok a platby** (balance +
> ledger + Zaplatiť) become views of their own; (d) the **„Ako to funguje“ explainer**
> (six phases, three delivery ways, „Kto sme a odkiaľ je káva“ with the two roasters,
> „Ako platím“, personal note), shown once after the first login and reachable from the
> menu, persisted in `friends.explainer_seen_at`; (e) the **subscription (cycle-type)
> filter is retired** from the UI (column + endpoint kept); (f) the **profile modal** per
> roadmap §19 (Login read-only, Meno a priezvisko *, Mobil *, E-mail, Packeta, password
> fold, no uid); (g) the **vocabulary rule** — no „cyklus“/„kolo“ anywhere a friend can
> read, with a grep guard. Small backend: `friends.explainer_seen_at` + its write route,
> `explainer_seen_at` in every login payload, and five extra columns on the
> `GET /friends/cycles` payload. `/cycle/:id` deep links keep working (R1.7).
> Out of scope (handoffs): the **timeline component and stage data** (`CycleTimeline.vue`,
> `order_cycles.opens_at/closes_at/stage`, friend-facing stage labels) → **17** (consumed
> here, never re-derived); **payment link formats / variable symbol / balance-payment
> reference** → **15** (consumed via ~~`PaymentModal.vue`'s frozen props~~ **its ADDITIVE
> props — PL-T3 landed 15 §UC-PL-004/D4 and the API is no longer frozen**: `variableSymbol`
> and `creditorName` joined `open`/`amount`/`reference`/`iban`/`revolutUsername`, every one
> of which is unchanged. What "frozen" still protects: a prop that REPLACES or reshapes an
> existing one breaks four screens at once. PI-T7 passes the two new props through when it
> RELOCATES PL-T4's balance trigger + mount — it never adds a second `PaymentModal`);
> **guest surfaces**
> (`/g/…`, standing link, pre-open page, guest explainer) → **19/20**; **WhatsApp opt-in
> semantics** (the `whatsapp_opt_in` checkbox module 21 inserts into this profile modal)
> → **21**; the **admin app** (untouched — admin invariance re-asserted); the **voucher
> modal** (00-overview: out of every restyle; one copy-only word fix here, UC-PI-017).
> Actors: **Friend** — the only actor on these screens (host capabilities — share dialog,
> Kolegovia panel — are module 05's and are reached from here unchanged). **Admin** —
> appears only as „správca“ in copy and as the author of `opens_at`/`closes_at`/`stage`
> (module 17) and of `paid` (money rules unchanged). **Guest** — never sees these screens.
> Sources: `docs/superpowers/specs/2026-09-03-roadmap-requirements.md` §1 (F1, R1.1–R1.7;
> R1.2 rewritten 2026-09-04: ONE open cycle max, no tabs), §2 (F2, R2.1–R2.6; Q2.a
> DECIDED 2026-09-06: Pozvať stays in the appbar), §3.3–3.4 (explainer; R3.4.1 DROPPED;
> corrected Packeta sentence), §13 (Kto sme a odkiaľ je káva; `lib/roasters.js`), §16
> (decisions: „objednávka“ wording, no public page, subscription filter retired, bakery
> retiring), §18 row 6, §19 (profile modal, PO review 2026-09-18/19 — the NEWEST source);
> prototype `docs/design/friends-portal-redesign/friends/portal2.jsx` + `portal2.css` +
> README addenda 2026-09-05/06 (layout + copy authority; states open / closed / locked /
> first); `docs/specification/00-overview.md` §Scope extension — roadmap October 2026 +
> glossary („Round / objednávka“); `01-architecture.md` §Roadmap additions (`explainer_seen_at`,
> `whatsapp_opt_in` lives in the profile but its semantics are module 21), §Frontend
> structure, §Design system; `02-design-system.md` (BrandChrome slots, NeoModal, NeoCopyRow,
> NeoCheckbox); `03-friend-login-portal.md` (the portal spec this module SUPERSEDES in
> parts — supersession map below); `04-friend-order.md` (UC-FO-001/002/009/014 — the shell,
> banners, cartbar and locked composition this module extends); `05-colleagues-panel.md`
> (UC-KG-006 share dialog contract); repo `CLAUDE.md` (Frontend hard rules: `.app > *`
> z-index trap, NeoModal/Teleport, one-home components, `friends.name` is never a login,
> `grep -i prihlasovac` must stay empty in `FriendPortalSession.vue`);
> `docs/learnings/03-friend-portal-restyle.md`; repo code (`frontend/src/views/FriendPortal.vue`,
> `FriendPortalSession.vue`, `FriendOrder.vue`, `components/FriendBalanceCard.vue`,
> `FriendTransactionsModal.vue`, `PaymentModal.vue`, `GuestShareDialog.vue`, `router.js`,
> `api.js`, `backend/src/routes/friends.js`, `orders.js`, `magic-link.js`, `db/schema.js`);
> shipped e2e specs (`portal-*.spec.js`, `guest-link.spec.js`,
> `portal-session-boundary.spec.js`, `friends-consolidation.spec.js`, `google-auth.spec.js`,
> `magic-link.spec.js`, `api-security.spec.js`). The most recent decision wins on conflict.
> **Design reference:** `docs/design/friends-portal-redesign/Podpultovka Friends.html` →
> screen **„Priateľ · portál v2 (2026-09)“**, state selector open / closed / locked /
> first, menu drawer, HistoryView, BalanceView, Explainer (`friends/portal2.jsx`,
> `friends/portal2.css`). Match layout and copy; money renders in the repo's `fmtEur`
> convention (`€` on lines, `EUR` on totals), not the prototype's (README addendum
> 2026-09-05 „Not a production contract“). Serve the prototype over HTTP (03 header note).

---

## Supersession map vs. module 03 (`UC-FL-*`)

| 03 item | Status here | Replacement |
|---|---|---|
| UC-FL-001 view scaffold, `.app` root, session restore, `document.title`, loading/error states, voucher modal untouched | **STAYS** (extended: three more routes render the same view — UC-PI-001) | — |
| UC-FL-002 modern login, UC-FL-003 legacy/transition login | **STAY** verbatim (login-state chrome untouched) | — |
| UC-FL-004 appbar — clickable `.titles` → profile, pencil, logout glyph | **SUPERSEDED** | UC-PI-003 appbar (menu · brand+view subtitle · Pozvať · lock); profile + logout live in the drawer (UC-PI-004) |
| UC-FL-004 „Pozvať“ chip | **STAYS** (Q2.a decided 2026-09-06) | UC-PI-003 |
| UC-FL-005 balance card on the landing + „Transakcie“ button + `FriendTransactionsModal` | **SUPERSEDED** (R2.3: zero/positive balance never on the landing) | UC-PI-008 debt banner (landing), UC-PI-010 Zostatok a platby view; `FriendTransactionsModal.vue` retired |
| UC-FL-006 cycle list — heading „Objednávkové cykly“, gear, cycle cards, badges, empty states | **SUPERSEDED** (R1.1, R1.5, R2.5) | UC-PI-005/006/007 landing states; UC-PI-009 history; UC-PI-016 gear retired |
| UC-FL-007 share row + colleague-count fan-out on cycle cards | **SUPERSEDED** | UC-PI-011 — cartbar share icon + drawer item (one count fetch, current open cycle only) |
| UC-FL-008 archive fold | **SUPERSEDED** | UC-PI-009 Moje objednávky |
| UC-FL-009 profile modal | **AMENDED** — field set/labels per roadmap §19 (UC-PI-015); `saveProfile`/`changePassword` behaviour, Google section (module 10) and the `friends.name` grep guard STAY | UC-PI-015 |
| UC-FL-010 subscription modal | **RETIRED** (R2.5; PO 2026-09-04 bakery retiring) | UC-PI-016 |
| UC-FL-011 invite modal | **STAYS** verbatim (opened from the chip and from the drawer) | UC-PI-003/004 |
| UC-FL-012 forced password change | **STAYS** verbatim | — |
| UC-FL-013 verification — pin table + immutability rule | pins on superseded structures are **retargeted under case (a)**; the rule itself STAYS | UC-PI-019 |

---

## Resolved conflicts (recency / canonicity)

1. **Roadmap §1 R1.6 („kolo“ allowed in history) vs §16 (2026-09-06: „objednávka“, never
   „kolo“/„cyklus“) vs prototype tickers/banners still saying „ĎALŠIE KOLO“ /
   „z minulého kola“.** §16 is newest and wins everywhere, including over the prototype's
   copy — the prototype addendum 2026-09-06 itself says „objednávka replaces kolo in
   every user-facing message“. Every such string is rewritten in this file (UC-PI-017);
   history lists rounds by their **cycle name** (§16).
2. **Q2.a default („Pozvať“ into the menu) vs §16 decision (chip stays in the appbar).**
   §16 wins: appbar = menu · brand · Pozvať chip · lock chip (closed/locked only). The
   drawer ALSO lists „Pozvať priateľa“ (prototype) — two entry points, one modal.
3. **§3.3 „shown once … dismiss = Rozumiem“ vs prototype's „Už mi to neukazovať“
   checkbox (unticked by default).** Both are kept; `OPEN:` default — the checkbox is
   **pre-ticked** on the first-login showing, so a bare „Rozumiem, idem na ponuku“ records
   `explainer_seen_at` (§3.3's „shown once“ holds) and un-ticking defers it to the next
   login (the prototype's control keeps its meaning). PO may flip the default.
4. **§19 help text „Prihlasovacie meno. Nemení sa.“ vs CLAUDE.md hard rule
   (`grep -i prihlasovac frontend/src/views/FriendPortalSession.vue` must stay empty;
   pinned by `portal-profile-modal.spec.js:424`).** The hard rule wins on the letter and
   §19 on the meaning: the read-only row is labelled **„Login“** with help
   **„Meno, ktorým sa prihlasujete. Nemení sa.“** — same statement, no forbidden adjective.
5. **03 UC-FL-005 „always show the balance card“ vs R2.3 / §9 item 5 („hide a zero
   balance from the landing; never hide debt“).** R2.3 wins (the restyle decision predates
   the newcomer feedback — roadmap §2). `OPEN:` debt banner on the landing — default **yes**
   (00-overview §Open prototype decisions).
6. **R1.3 „the friend can still browse the catalogue“ vs prototype wrapping tabs AND cards
   in `.p2-ro` (`pointer-events:none`).** R1.3 wins: only the **cards** are read-only/faded;
   the category strip stays interactive so every category is browsable.
7. **Prototype views are in-place state vs. browser back-button on phones.** Spec-author
   decision: the four views are **routes** (`/`, `/moje-objednavky`, `/zostatok`,
   `/ako-to-funguje`) rendered by the SAME `FriendPortal.vue` instance, so back returns
   to the offer instead of leaving the site, and „Ako to funguje“ is linkable. The
   prototype is the layout/copy authority, not the routing authority.
8. **03 UC-FL-008 archive rows listed EVERY completed cycle (with or without an order) vs
   R1.5 „archived cycles with the friend's order per cycle“ / §16 „history lists rounds“.**
   „Moje objednávky“ lists only rounds where the friend **has a submitted order**
   (`hasOrder`); a round without one is not an objednávka. Recorded as a decision, not an
   OPEN.
9. **Prototype drawer header „{code} · člen od 2024“ vs §16/§19 „a friend never needs to
   see their uid“.** §16 wins: the header shows the friend's `name` only.
   `OPEN:` a „člen od {rok}“ line from `friends.created_at` — default omitted.
10. **`FriendOrder.vue`'s `.titles` subtitle** stays the friend's `name` on the deep-link
    route (learnings 03: the uid is optional in the stored session shape; consistency won).

---

## UC-PI-001 Portal shell — routes, views and the session boundary (Friend)

**Goal:** `FriendPortal.vue` stays the one authenticated shell; it now renders four views
under four routes, all inside the SAME session component instance.

**Routes (`router.js`, all → `() => import('./views/FriendPortal.vue')`):**

| Path | `name` | `meta.view` |
|---|---|---|
| `/` | `friend-portal` (existing) | `shop` |
| `/moje-objednavky` | `friend-history` | `history` |
| `/zostatok` | `friend-balance` | `balance` |
| `/ako-to-funguje` | `friend-explainer` | `explainer` |
| `/cycle/:cycleId` | `friend-order` (existing, UNCHANGED) | — (standalone, UC-PI-018) |

**Business rules:**

- **The auth state machine is untouched** (03 UC-FL-001): `loading | login | authenticated`,
  session restore, `beginSession` handshake, forced-password gate, voucher check. An
  unauthenticated visit to any of the four paths shows the login state; after login the
  session renders the view named by `route.meta.view`. The three new paths are friend
  surfaces (join the module 02 zero-external-requests sweep — `self-hosted-fonts.spec.js`).
- **Session boundary rule holds.** `FriendPortalSession.vue` stays keyed on the auth
  HANDSHAKE (`:key="sessionSeq"`, FriendPortal.vue:136-146 — the orchestrator's
  „`:key="friendId"`“ shorthand resolves to this shipped key; keying on identity flushes
  at the first `await`, learnings 03). **Every** new piece of state this module adds —
  `view`, `menuOpen`, `closedModalDismissed`, the resolved current cycle, history
  expansion, balance/transactions, explainer state, drawer counts — lives in
  `FriendPortalSession.vue` or its children, **never** in `FriendPortal.vue`. Nothing may
  be hoisted into a plain `<script>` block or `localStorage` (session data of friend A
  would greet friend B).
- The session root carries **`data-testid="portal-landing"`** in every view and state —
  this is the e2e „portal is ready“ marker that replaces the retired heading gate
  (UC-PI-019 item 1).
- `view` is derived from the route (`computed(() => route.meta.view)`); drawer navigation
  is `router.push(path)`; the explainer's „Rozumiem, idem na ponuku“ and its back chevron
  are `router.push('/')`.
- Page column idiom unchanged: `mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7`
  (03 UC-FL-006). The column may now carry `p-4`-free padding as before; the `div.p-4`
  cycle-card pin is retired with the cards (UC-PI-019), so the prohibition is historical —
  keep the idiom anyway for fidelity.
- `document.title` stays `'Gorifi - Objednávky'` (03 UC-FL-001 OPEN still open).
- The **voucher modal and `voucherResolved` banners** stay functionally and visually
  untouched, rendered from inside the session as today.

**Acceptance criteria:** `/zostatok` anonymous ⇒ login state; after login ⇒ the balance
view with `portal-landing` visible; logout from `/moje-objednavky` ⇒ login state on the
same URL; login as A, open every view, log out, log in as B ⇒ `portal-session-boundary`
invariants hold (UC-PI-019 item 14).

---

## UC-PI-002 Current-round resolver + `GET /friends/cycles` payload extension (Friend, system)

**Goal:** one deterministic rule turns the cycles list into the landing state.

**Backend — `GET /friends/cycles` (friends.js:624-735), additive:**

- SELECT adds `c.opens_at, c.closes_at, c.stage, c.parcel_enabled, c.parcel_fee`
  (`opens_at/closes_at/stage` exist once **module 17** lands — ⚠ hard dependency, the
  columns are 17's; this module only reads them).
- Per-friend order block adds `orderPaid` (`!!order.paid`) and `orderHandedOver`
  (`order.handed_over_at != null` — column from **module 16**; read via
  `SELECT o.paid, o.handed_over_at`; if 16 has not landed, `orderHandedOver` is `false`
  and the SELECT must not name the column — implementer checks `schema.js`).
- The subscription filter block **stays** (R2.5 keeps the endpoint); it is inert for a
  coffee-only catalogue and „always show cycles where the friend has an order“ keeps
  bakery history visible.
- Nothing else changes: `ORDER BY c.created_at DESC`, `_placeholder` exclusion,
  `roundMoney` on `orderTotal`.

**Client — resolver (in `FriendPortalSession.vue`, pure function `resolveLanding(cycles)`
in `lib/portal-state.js` so it is unit-checkable from e2e via the DOM):**

| Precedence | Condition | `state` | `currentCycle` |
|---|---|---|---|
| 1 | ≥1 cycle with `status === 'open'` | `open` | the FIRST open one in API order (newest `created_at`). If more than one: `console.warn('[portal] more than one open cycle', ids)` (R1.2) |
| 2 | else ≥1 `status === 'locked'` | `locked` | the newest locked |
| 3 | else | `closed` | `catalogCycle` = the newest cycle with `status ∈ {locked, completed}` (read-only grid source); `null` when none exist |

Plus, in every state: `nextCycle` = the newest `status === 'planned'` cycle (or `null`).
`nextText` (one home, `lib/portal-state.js`):
- `nextCycle.opens_at` set ⇒ **„Ďalšia objednávka sa otvorí približne {fmtDayMonth(opens_at)}“**
  + weeks suffix **„(o {n} týždne)“** with Slovak plural (`1` ⇒ „o týždeň“, `2–4` ⇒
  „o {n} týždne“, `≥5` ⇒ „o {n} týždňov“, `n = Math.round(days/7)`; `n ≤ 0` ⇒ suffix omitted);
- else `nextCycle.plan_note` ⇒ the note verbatim (`white-space:pre-line`, `overflow-wrap:anywhere`);
- else ⇒ **„O ďalšej objednávke dáme vedieť.“** (R1.3, „kole“ → „objednávke“ per §16).

⚠⚠ **PI-T1 AMENDMENT (2026-09-20) — `nextText` WAS NOT IMPLEMENTED HERE, AND THE DATE
FORMAT IS AN OPEN PO QUESTION.** Module 17 shipped `nextOpeningText()` in
`lib/cycle-stages.js` the day before this row ran, with exactly the three branches above, so
`resolveLanding` **delegates** rather than carrying a second copy (one-home rule; pinned by a
byte-equality assertion in `portal-shell.spec.js`). Likewise the open→locked precedence and
the two-open `console.warn` come from 17's `currentCycleFor()` — the warning therefore reads
`[cycle-stages] N cycles are open at once — using the newest`, not the `[portal]` text above.
⚠ **The one genuine conflict:** 17 renders that sentence with `fmtDay` („približne **3.
októbra**"), this section with `fmtDayMonth` („približne **3. 10.**"). PI-T1 kept 17's shipped
form, because the alternative is a second home for one sentence. ⚠ **The consequence,
stated precisely (corrected in the PI-T1 review — the first wording said „both forms in one
modal", which a PI-T4 implementer would have found false and might then have concluded the
conflict had evaporated):** the same CLOSED landing prints both — the SHORT form in
§UC-PI-006's modal card, and the LONG form in the warn banner that REPLACES the modal after
dismissal, and again in §UC-PI-007's next-round banner. In the `opens_at === null` branch the
modal card carries `nextText` alone, so there is no collision inside the modal at all.
**PI-T4 must not resolve this at a call site** — it is one sentence with one home until the PO
rules. ~~`{fmtDayMonth(opens_at)}` in the sentence~~
— see `docs/learnings/10-portal-ia.md` §1 for the two options. **PI-T4 must not resolve it at
a call site.** `lib/dates.js` below is built as specified and is correct for every OTHER
surface.

**Dates one home — `frontend/src/lib/dates.js`:** `fmtDayMonth(iso)` → `12. 9.`,
`fmtDate(iso)` → `12. 9. 2026`, `fmtWeekdayDayMonth(iso)` → `piatku 12. 9.` (genitive
weekdays: pondelka, utorka, stredy, štvrtka, piatku, soboty, nedele), `weeksUntil(iso)`.
Input is the ISO date part of module 17's TEXT columns; an unparsable value renders the
raw string. `OPEN:` whether a time part of `closes_at` is displayed („do piatku 12. 9.,
18:00“) — default: date only.

**Acceptance criteria:** seed {planned(opens_at), open, locked} ⇒ `open`; {planned, locked}
⇒ `locked` + banner text from the planned; {completed only} ⇒ `closed` with the completed
catalogue; two open ⇒ newest + one console warning (asserted via `page.on('console')`);
the payload carries the five cycle columns and the two order flags.

---

## UC-PI-003 Appbar and brand chrome per state (Friend)

**Goal:** R2.1 + §16: appbar = **menu button · brand + view subtitle · Pozvať chip · lock
chip (not open)**; nothing else.

**Structure (BrandChrome slots, 02 UC-DS-006; order fixed):**

- `#leading`: in views `shop | history | balance` — `span.p2-icobtn` with
  `NeoIcon name="menu"` (new icon, 3 bars, prototype `I2.menu`), `role="button"
  tabindex="0" aria-label="Menu"`, click/Enter/Space → `menuOpen = true`. In view
  `explainer` — the existing `span.back` (`NeoIcon name="back"`, `aria-label="Späť"`)
  → `router.push('/')`; the menu button is absent there (prototype).
- `#titles`: wordmark `<span class="t">Pod<span style="color:var(--accent)">pult</span>ovka</span>`
  + `<span class="s">{{ subtitle }}</span>` where subtitle = `shop`: **„Aktuálna ponuka“**
  (open/closed) / **„Vaša objednávka“** (locked with own order); `history`: **„Moje
  objednávky“**; `balance`: **„Zostatok a platby“**; `explainer`: **„Ako to funguje“**.
  `titlesAction` is **empty in every state** — `.titles` carries no `role`, no `tabindex`,
  no `aria-label` (reverses 03 UC-FL-004; the login-state opt-out becomes the rule).
- `#after-titles`: **nothing** (the pencil is retired).
- `#trailing`: `span.chip.acc` with `NeoIcon name="invite"` + text **„Pozvať“**,
  `role="button" tabindex="0" title="Pozvi priateľa"` → `openInviteModal()` (03 UC-FL-011
  verbatim); then, when `state !== 'open'`, `span.chip.p2-lock` with `NeoIcon name="lock"`,
  `title` = **„Objednávky sú uzamknuté“** (locked) / **„Objednávky sú zatvorené“** (closed),
  `aria-hidden="true"` (decorative; the state is spoken by the banner). No logout glyph.
- `ticker` (authenticated): open **„+++ OBJEDNÁVKY OTVORENÉ +++ NEHOVOR O TOM NAHLAS +++“**;
  locked **„+++ OBJEDNÁVKY UZAMKNUTÉ +++ KÁVA JE NA CESTE +++“**; closed
  **„+++ OBJEDNÁVKY ZATVORENÉ +++ ĎALŠIA OBJEDNÁVKA {suffix} +++“** where suffix =
  `O {n} TÝŽDNE|TÝŽDEŇ|TÝŽDŇOV` when `nextCycle.opens_at` yields `n ≥ 1`, else
  **„DÁME VEDIEŤ“** (the prototype's „ĎALŠIE KOLO“ is rewritten — resolved conflict 1).
  Login-state ticker and titles unchanged (03 UC-FL-001).

**Business rules:** the chrome is not sticky (02 UC-DS-005/006). Exactly ONE `.chip.acc`
in the appbar (the `portal-appbar.spec.js` `.appbar .chip.acc` locator keeps resolving to
the Pozvať chip; the lock chip is `.chip.p2-lock`, never `.acc`). The `.titles .t`
ellipsis rule stays; the subtitle is a fixed string, never free text.

**Acceptance criteria:** open ⇒ menu, wordmark, „Aktuálna ponuka“, Pozvať, no lock, ticker
„OBJEDNÁVKY OTVORENÉ“; closed with `opens_at` 4 weeks out ⇒ lock chip + ticker „ĎALŠIA
OBJEDNÁVKA O 4 TÝŽDNE“; `.appbar [data-testid="profile-pencil"]`,
`.appbar [aria-label="Odhlásiť sa"]` and `.appbar .titles[role]` all count 0.

---

## UC-PI-004 Hamburger drawer — `NeoDrawer.vue` (Friend)

**Goal:** R2.2/R2.6: one full-height left drawer on the modal layer, on phone and desktop
alike.

**Component:** `frontend/src/components/neo/NeoDrawer.vue` — `<Teleport to="body">` →
`div.modal-layer` → `div.p2-drawer-scrim` → `aside.p2-drawer` (`role="dialog"
aria-modal="true" aria-label="Menu"`). It shares NeoModal's behaviours **through one
implementation** (extract `useModalLayer()` composable from `NeoModal.vue` — capture-phase
scrim mousedown rule, Esc closes, focus trap, body scroll lock, `v-if` mount by the
parent): two copies of the scrim logic is how one stops working (02 UC-DS-010 RD-FL-6
amendment). ⚠ Never a hand-rolled `position:fixed` child of `.app` (CLAUDE.md `.app > *`).
CSS: `portal2.css` is ported **verbatim** into `friends-theme.css` as a new trailing
section (adaptation list entry **A13** — a canon sync, not an ad-hoc edit; the prototype
CSS is part of the handoff).

**Header (`.p2-dh`):** wordmark (`.display`, 25px), friend `name` (700, 15px), no uid
(resolved conflict 9); `span.p2-icobtn` × (`aria-label="Zatvoriť menu"`).

**Items (`.p2-mi`, in THIS order; each `role="button" tabindex="0"`, Enter/Space):**

| # | `.lab` | `.sub` | Condition | Action |
|---|---|---|---|---|
| 1 | Aktuálna ponuka | open: **„Otvorené do {fmtDate(closes_at)}“** (omit „do …“ when `closes_at` null ⇒ „Objednávky sú otvorené“) + **„ · v košíku {fmtEur(cartTotal)}“** when the landing cart total > 0; closed/locked: **„Objednávky sú zatvorené“** | always | `router.push('/')` |
| 2 | Moje objednávky | **„{n} objednávky · naposledy {cycleName}“** via `ordersAccusativeLabel(n)` (`lib/plural.js`) where n = rounds with `hasOrder`; n = 0 ⇒ **„Zatiaľ žiadne“** | always | `/moje-objednavky` |
| 3 | Zostatok a platby | trailing badge: `span.badge.danger` `{fmtEur(balance)}` when `balance < -0.01`, else `span.badge.ok` `{fmtEur(balance)}`; while loading no badge | always | `/zostatok` |
| 4 | Zdieľať s kolegami | **„{colleaguesLabel(count)} · {kg} kg cez váš odkaz“** (03 UC-FL-007 semantics: `totals.count` excludes cancelled; kg via `lib/kg.js kgLabel()`, the one home since FUP-T24 — ⚠ it returns the whole
  „X kg" string, so the template above reads „{colleaguesLabel(count)} · {kgLabel(g)} cez váš odkaz",
  NOT „… {kg} kg" (that would render „0.25 kg kg"); count 0 ⇒ **„Pošlite odkaz kolegom“**) | ~~`state === 'open'` only~~ **GL-T6c (19 §UC-GL-008): open, locked, and closed WITH a catalogue — wherever a `FriendOrder` mount hosts the one dialog; on a non-open round it opens standing-only (`cycleId = null`), no count is fetched, sub = „Pošlite odkaz kolegom“; closed with no catalogue ⇒ no row (recorded gap, learnings 11 §GL-T6c)** | opens `GuestShareDialog` (UC-PI-011) |
| 5 | Pozvať priateľa | **„Váš pozývací odkaz“** | always | `openInviteModal()` |
| 6 | Ako to funguje | — | always | `/ako-to-funguje` |
| 7 | Profil | **„Meno, telefón, Packeta, heslo“** | always | `openProfileModal()` |

Footer: `button.btn.ghost` **„Odhlásiť sa“** (`NeoIcon name="logout"` + text) →
`switchUser()` (03 UC-FL-004 behaviour, unchanged) + `span.sub.mono` **„podpultovka.biz“**.
The item whose view is current gets `.on` (only items 1/2/6 map to a view).

**Business rules:**

- Choosing any item closes the drawer first (`menuOpen = false`), then acts.
- The colleague count for item 4 is ONE `GET /guest-links/cycle/:id` for the current open
  cycle, fired after the cycles load, **sequence-guarded** (the 03 UC-FL-007 `loadSeq` rule
  — bumped on every cycles load and on logout); failure ⇒ the „Pošlite odkaz kolegom“ sub,
  never an error. The bounded fan-out of 03 is gone (one cycle).
- Balance for item 3 comes from the same `api.getFriendBalance(friendId)` call the debt
  banner uses (UC-PI-008) — one request per session load, shared state.
- Esc, scrim click and × close; `getByRole('dialog')` count returns to 0 (the drawer is a
  dialog — shipped specs that count dialogs must open it deliberately).
- Slovak vy-form; the labels are the exact strings above (they become e2e pins).

**Acceptance criteria:** items render in order 1–7 with the conditional 4th present only
on an open round **(GL-T6c: and on a locked / closed-with-catalogue one — see the table)**; „Odhlásiť sa“ returns to the login state; Tab cycles inside the drawer;
Esc closes; `.app .p2-drawer` count 0 (teleported).

---

## UC-PI-005 Landing — open state (Friend)

**Goal:** R1.1: the landing IS the order screen. `FriendOrder.vue` is the one home of the
order surface and is **extended, never forked**.

**`FriendOrder.vue` extension — new props:** `cycleId` (String|Number, overrides
`route.params.cycleId`), `friendId` (overrides the localStorage/in-memory restore), and
`mode` (`'route'` default | `'landing'`). In `landing` mode the view renders **no `.app`
root, no `BrandChrome`, no page-column wrapper** — the session view supplies them — and
its behaviour differs only where this module says so below. The `.cartbar` stays a THEME
class (`:where(.app,.modal-layer) .cartbar`), so it keeps its sticky footer whether it is
a direct child of `.app` or nested one level (learnings 03; `order-cartbar.spec.js`
geometry pins re-run on the landing).

**Landing composition (`view === 'shop'`, `state === 'open'`), top to bottom inside the
page column:**

1. **Status line** — `div.banner.slim` + `span.dot`:
   **„<b>Objednávky do {fmtWeekdayDayMonth(closes_at)}</b> Káva príde okolo {expected_date} — <a>Ako to funguje?</a>“**.
   `closes_at` null ⇒ **„<b>Objednávky sú otvorené.</b>“**; `expected_date` null ⇒ the
   „Káva príde …“ clause is omitted (`expected_date` is admin free text, rendered
   verbatim). The link is `router-link` to `/ako-to-funguje` (`font-weight:700`).
2. **Debt banner** (UC-PI-008) when `balance < -0.01`.
3. **FriendOrder body in `landing` mode**: the shipped `.banner.ok` „Vaša objednávka bola
   odoslaná!…“ (04 UC-FO-002, yields while unsent changes exist), messages, the
   Moja objednávka / Kolegovia **tabgroup** (04 UC-FO-003 — STAYS: the Kolegovia panel is
   where hosts manage sub-orders, module 05; the prototype is silent, silence is not
   removal), `.cat-tabs`, product cards, stock bars, steppers — all unchanged.
4. **`.cartbar`** unchanged except the **share icon** (UC-PI-011): `.actions` gains a
   leading `button.btn` (`flex:0 0 52px; padding:0`, `aria-label="Zdieľať s kolegami"`,
   `NeoIcon name="share"`) before „Zrušiť“; the shipped Zrušiť / Zaplatiť / Odoslať |
   Aktualizovať buttons and rules stay (04 UC-FO-009). The deadline line
   („Objednávka do: {expected_date}“) stays.

**Business rules:**

- Cart model, auto-save, dirty tracking, Spôsob prevzatia / Hotovo! / Zrušiť / leave
  modals (04 UC-FO-008..013) are byte-identical in behaviour. The leave guard
  (`onBeforeRouteLeave`) must fire for drawer navigation too — the drawer's
  `router.push` is a route leave.
- The success modal's close navigates to **`/`** — on the landing that is a no-op
  (already there); on `/cycle/:id` it returns to the landing (unchanged).
- The landing never lists cycles: `getByRole('heading', { name: 'Objednávkové cykly' })`
  count 0, `div.p-4` cycle cards count 0.
- `state === 'open'` but the friend's `GET /orders/cycle/:id/friend/:id` fails ⇒ the
  shipped fatal-error banner with the button relabelled **„Skúsiť znova“** → reload the
  order data (on the landing there is no list to go back to; UC-PI-018 keeps „Späť na
  ponuku“ on the deep link).

**Acceptance criteria:** login on an open cycle ⇒ product cards visible without a click;
status line text as specified; adding an item updates the cartbar total; the share icon
opens the share dialog titled with the cycle name and the URL stays `/`.

---

## UC-PI-006 Landing — closed state (Friend)

**Goal:** R1.3: no open round ⇒ read-only catalogue behind a dismissible state modal, then a
slim banner.

**Composition:**

1. **State modal** (`NeoModal`, `title` = **„Objednávky sú zatvorené“**, closable) — shown
   automatically **once per session** (`closedModalDismissed` in the session component;
   `OPEN:` modal once + banner — default per 00-overview; alternative banner-only):
   - `div.sub` **„Káva sa objednáva spoločne, v termínoch — pár dní naraz, potom ju
     nakúpime v pražiarni a rozdáme si ju.“**
   - `div.card.flat` (`background:var(--accent-soft)`): `field-lbl` **„Ďalšia objednávka
     sa otvorí približne“** + `.display` 38px `{fmtDayMonth(opens_at)}` + `.sub` 700
     **„{weeks} · dáme vedieť cez WhatsApp“** — when `opens_at` is null the card body is
     `nextText` (UC-PI-002) in `.display` 22px instead.
   - `field-lbl` **„Kde sme teraz“** + `CycleTimeline` **compact dots variant** (module 17
     — ~~`variant="dots"`~~ **`variant="compact"`, the name CS-T2 actually shipped
     (17 §UC-CS-006 always said `compact`; corrected in place by PI-T4)**,
     `cycle = nextCycle ?? catalogCycle`; 17 owns which dot is „now“ — the consumer passes
     `:cycle` and NEVER `:steps`)
     + the three mono captions **Pauza · Objednávky · Doručenie**, which belong to the
     CONSUMER: `CycleTimeline` renders dots only, by its own spec. Which caption is
     emphasised comes from 17's `stageIndex()` (0 ⇒ Pauza, 1 ⇒ Objednávky, 2–5 ⇒ Doručenie),
     never from a locally assembled step array.
   - Footer: `button.btn` **„Ako to funguje“** → dismiss + `/ako-to-funguje`;
     `button.btn.accent` **„Prezrieť ponuku“** → dismiss. ×/Esc/scrim = dismiss.
2. After dismissal: `div.banner.warn.slim` + `span.dot`:
   **„<b>Objednávky sú zatvorené.</b> {nextText}“** (e.g. „Ďalšia objednávka približne
   <b>3. 10.</b>“ — the bolded date form when `opens_at` exists).
3. Debt banner (UC-PI-008) if any.
4. **Read-only catalogue** from `catalogCycle`: caption row `span.field-lbl`
   **„Minulá ponuka · {catalogCycle.name}“** + `span.sub.mono` **„len na prezretie“**;
   `.cat-tabs` interactive (resolved conflict 6); the cards wrapper carries **`.p2-ro`**
   (opacity .55, `pointer-events:none`); every stepper `disabled`; **stock bars hidden**
   (`[data-testid="stock-bar"]` count 0); **no `.cartbar`**, **no tabgroup**, no
   status/ok banners. `catalogCycle === null` ⇒ centred `.sub` **„Ponuka ešte nie je
   pripravená.“** in place of the grid.

⚠ **PI-T4 note (2026-09-20) — the two date formats in this state are NOT a defect:**
the card above prints `fmtDayMonth` („3. 10.“) while item 2's banner prints module 17's
composed sentence („približne 3. októbra“). Both are specified, by two modules, for the
same date; see the amendment at §UC-PI-002 and `docs/learnings/10-portal-ia.md` §1 and
PI-T4 §1. `portal-landing.spec.js` §5 pins BOTH halves, so the PO decision is a
one-expectation edit — and neither half may be reconciled at a call site.

**Business rules:** `FriendOrder` in `landing` mode with `readonly: true` renders the grid
this way (extend UC-FO-014's locked rendering with the `.p2-ro` wrapper + hidden stock
bars; never a second card template). No order is created or loaded for a completed
catalogue cycle (`GET /orders/cycle/:id/friend/:id` is still called — it does not
auto-create, orders.js:97 — but its `order` is ignored in `readonly`). The modal is a
NeoModal on the modal layer (`getByRole('dialog')` count 1 while shown).

**Acceptance criteria:** completed-only seed ⇒ modal on first render with the planned
date, dismiss ⇒ warn banner + faded grid, reload ⇒ modal again (per session, not
persisted), drawer reachable; tab switch works while cards are inert; no `.cartbar`.

---

## UC-PI-007 Landing — locked state (Friend)

**Goal:** R1.4: the friend ordered, the round is locked ⇒ where is my coffee.

**Composition (`state === 'locked'`, `hasOrder` on `currentCycle`), top to bottom:**

1. Debt banner (UC-PI-008) if any.
2. **Own-order card** `div.card.hl` (padding 16), `data-testid="own-order-card"`:
   - head row: `.display` 22px **„Vaša objednávka“** + `span.badge.ok` **„Odoslaná“**;
   - lines via **`CartLineList`** (the one home for ordered-items lists; the same
     normaliser FriendOrder feeds it — hoist to `lib/order-lines.js` if it is inline
     today) incl. the Packeta fee line when `delivery_fee > 0`;
   - `.p2-tot`: `field-lbl` **„Spolu“** + `.display` 22px `{fmtEur(paymentTotal)}`;
   - pickup row (border-top 2px 12%): `span.badge` with `NeoIcon name="pin"` + the party's
     delivery target — `pickup_location` name / `pickup_location_note` verbatim /
     **„Packeta · {packeta_address}“** (read from the loaded order; `helpers/pickup.js`
     semantics: exactly one of the three exists);
   - payment row: `order.paid` ⇒ `span.badge.ok` **„Zaplatené“**; else `span.badge.warn`
     **„Nezaplatené“** + `button.btn.sm.accent` **„Zaplatiť {fmtEur(paymentTotal)}“** →
     `PaymentModal` with the shipped props (`amount = paymentTotal`,
     `reference = paymentReference` — FriendOrder.vue:138 `${friend.name} / ${cycle.name}`
     until module 15 replaces it; `iban`, `revolutUsername` from payment settings). Button
     absent when `!hasPaymentSettings`.
3. **„Kde je vaša káva“** card (`padding:16px 16px 4px`): `field-lbl` + `CycleTimeline`
   **vertical variant** (module 17: `cycle = currentCycle`, ~~`order = the friend's order`
   so 17 can mark hand-over/delivery on the last steps~~ — 17 owns steps, labels and the
   „now“ rule; this module only mounts it).
   ⚠ **PI-T5 AMENDMENT (2026-09-20) — THERE IS NO `order` PROP, AND ADDING ONE IS NOT
   THIS MODULE'S CALL.** 17 §UC-CS-006 says in as many words „Props: `cycle`, `variant`,
   `steps`. **No other props**; no emits", and CS-T2 shipped it that way — `timelineSteps
   (cycle)` takes one argument. Passing `:order` would not be ignored either: Vue turns an
   undeclared prop into a FALLTHROUGH ATTRIBUTE, so it would land on the root `div` as
   `order="[object Object]"`. The mount therefore passes `:cycle` alone. The seam 17 DID
   ship for a consumer that wants its own per-step content is `steps` — and using it here
   would hand module 18 ownership of each step's `state`, which is the door 17's three
   measured stale-`stage` transitions come back through (learnings 09 §10). If the last
   two steps should react to `handed_over_at`, that is a module-17 change to
   `timelineSteps()`, not a prop invented at this call site.
4. **Next-round banner** `div.banner.slim`: **„<b>Ďalšia objednávka</b> {nextText-short} —
   ponuku si už môžete prezrieť nižšie.“** where short = „približne <b>{date}</b>“ /
   plan_note / „— dáme vedieť“. Rendered only when `nextCycle` exists OR `catalogCycle`
   grid follows (always true here).
5. **Read-only grid** of `currentCycle` (caption **„Ponuka · {cycle.name}“** + „len na
   prezretie“), `.p2-ro`, stock bars hidden, **no `.cartbar`**; the **tabgroup STAYS**
   (Kolegovia hand-over ticks happen precisely now — module 05 UC-KG-004).

**Locked, NO own order:** the closed-state treatment (UC-PI-006) with the modal title
**„Objednávky sú uzamknuté“** and intro **„Táto objednávka je už uzavretá — káva je
objednaná v pražiarni.“**, the next-round card, the dots; then the warn banner
**„<b>Objednávky sú uzamknuté.</b> {nextText}“** and the read-only grid of `currentCycle`.
Subtitle stays „Aktuálna ponuka“.

⚠ **PI-T5 decisions on this branch, recorded because the paragraph above is silent on
both (2026-09-20):**
- **The dots are handed `currentCycle`, NOT §UC-PI-006's `nextCycle ?? catalogCycle`.**
  „Kde sme teraz“ on a locked landing is the round in flight; the closed rule would print
  „Pripravujeme ďalšiu objednávku“ over a round whose coffee is at the roastery. This is
  the question `LandingStateModal`'s `timelineCycle` prop exists to let the caller answer.
- **The tabgroup STAYS here too**, i.e. item 5's rule is a property of the LOCKED landing
  and not of „the friend ordered“. A host who ordered nothing themselves while their
  unregistered colleague did is the exact party `helpers/pickup.js`'s PO decision
  (2026-09-03) is about, and their hand-over ticks happen precisely now (05 §UC-KG-004).
  Hiding Kolegovia from them would hide it from the one person who needs it.

**Business rules:** `own-order-card` renders from FriendOrder's loaded `order` (no second
loader); the shipped locked `.banner.warn` „Objednávky sú uzamknuté. Už nie je možné meniť
objednávku.“ and the locked cartbar (04 UC-FO-014) are **replaced on the landing only**;
they stay on the `/cycle/:id` deep link. Money: `paymentTotal` includes `delivery_fee`
(04 resolved conflict #9). The `paid` flag is read-only here (admin-only write).

**Acceptance criteria:** locked + submitted order ⇒ card with lines, total, pickup badge,
„Nezaplatené“ + „Zaplatiť“ opening PaymentModal with the order total; admin marks paid ⇒
„Zaplatené“, no button; locked without order ⇒ modal „Objednávky sú uzamknuté“; grid inert,
tabs live, no cartbar.

---

## UC-PI-008 Debt banner + Zaplatiť from the landing (Friend)

**Goal:** R2.3 / §9 item 5: never hide debt; never show a settled balance on the landing.

**Structure:** `div.banner.danger.slim` (`align-items:center`), `data-testid="debt-banner"`:
`span.dot` + **„<b>Nedoplatok {fmtEur(-balance)}</b>“** + `button.btn.sm.accent`
**„Zaplatiť“** → `PaymentModal` with `amount = -balance`. (The prototype's „z minulého
kola“ is dropped — resolved conflict 1 — and nothing replaces it.)

**Business rules:**

- Source: `api.getFriendBalance(friendId)` once per session load (shared with the drawer
  badge and the balance view); rendered only when `balance < -0.01` (the shipped
  `balanceState` thresholds, `FriendBalanceCard.vue`). Zero/positive ⇒ nothing on the
  landing (no `Môj účet`, no `Transakcie`).
- Shown in all three landing states, above the own-order card in `locked`.
- `reference` for a **balance** payment: `OPEN` seam to **module 15** (R6.3: balance
  payments carry `VS = friend.id`-prefixed, server-owned). Until 15 lands, the reference is
  **„{friend.name} / zostatok“** (composed client-side like the shipped order reference);
  module 15 replaces both in `PaymentModal`'s caller contract. `iban`/`revolutUsername`
  from `api.getPaymentSettings()`; the button is absent when neither is configured.
- A failed balance fetch renders NO banner and no error on the landing (the balance view
  owns the error surface).
- No ledger write of any kind from this surface (the friend paid toggle is admin's;
  CLAUDE.md Money).

**Acceptance criteria:** balance −52.80 ⇒ banner „Nedoplatok 52.80 EUR“ + Zaplatiť →
PaymentModal subtitle „Suma na úhradu: 52.80 EUR“; balance 0 / +10 ⇒ no banner and no
balance text anywhere on the landing.

---

## UC-PI-009 Moje objednávky — history view (Friend)

**Goal:** R1.5: past rounds move to a menu item; same data as the retired archive fold.

**Structure (`/moje-objednavky`):** `<h2 class="h-screen">Moje <span class="hl">objednávky</span></h2>`
(28/34 px) + one `div.card` per round, newest first (API order), current round (`open` or
`locked`) gets `.hl`, the rest `.flat`; `padding:14px`, `cursor:pointer`,
`data-testid="history-round"`:

- head: `.display` 20px **cycle name** (`overflow-wrap:anywhere`), badge row (`.badge`
  per the table), right: `.display` 18px `{fmtEur(orderTotal)}` + `span.chev` (`.open`
  when expanded).
- expanded body (`margin-top:12px`): **`CartLineList`** with the round's lines
  (`€` per line), fee line when `delivery_fee > 0`; while loading `.sub` „Načítavam...“;
  error ⇒ `.banner.danger.slim` inside the card.

**Badge table (one row; `orderHandedOver`/`stage` from UC-PI-002's payload):**

| `status` | `stage` | `orderHandedOver` | badge |
|---|---|---|---|
| `open` | – | – | `badge acc` **Odoslaná** |
| `locked` | `ordered` / null | false | `badge` **V pražiarni** |
| `locked` | `arrived` | false | `badge acc` **Balíme** |
| `locked` | `ready` | false | `badge acc` **Zabalená** |
| `locked` | any | true | `badge ok` **Odovzdaná** |
| `completed` | – | – | `badge ok` **Vyzdvihnuté** |

⚠ These are the SHORT history forms owned here; the timeline's long labels are module 17's.

**Business rules:**

- Lists only rounds with `hasOrder` (resolved conflict 8) — bakery rounds included
  (R1.2: bakery history stays visible). Empty ⇒ centred `.sub` **„Zatiaľ žiadne
  objednávky.“** + `router-link` **„Prezrieť aktuálnu ponuku“** → `/`.
- Lines are fetched **lazily on first expand** via `api.getOrderByFriend(cycle.id,
  friendId)` (existing endpoint), cached per round for the session, **per-row pending +
  a per-row `rowSeq`** (repo convention); a stale response never writes into another
  round. One round expanded at a time (prototype toggle).
- Clicking the card toggles; the card does NOT navigate (the archive rows used to — 03
  resolved conflict #4 is reversed here: the deep link `/cycle/:id` remains available but
  history is a reading surface). `OPEN:` a „Otvoriť“ link per round to `/cycle/:id` —
  default omitted.
- Totals: `orderTotal` (already `total + delivery_fee`, rounded server-side).

**Acceptance criteria:** three rounds (open ordered, locked arrived, completed) ⇒ three
cards, badges Odoslaná / Balíme / Vyzdvihnuté, totals in EUR; expanding fetches once and
shows `li.ln` lines; a round without an order is absent; no „Archív“ text anywhere.

---

## UC-PI-010 Zostatok a platby — balance view (Friend)

**Goal:** R2.3: the whole money picture lives here.

**Structure (`/zostatok`):** `<h2 class="h-screen">Zostatok <span class="hl">a platby</span></h2>`,
then:

1. **Account card** — `FriendBalanceCard.vue` **re-purposed** (~~one home for the balance
   fetch~~ + the three-state derivation; the „Transakcie“ button is removed): `div.card`
   (+`.hl` when negative), `padding:16`; `field-lbl` **„Môj účet“**; `.display` 38px
   `{fmtEur(balance)}` coloured `var(--danger)` (neg) / `var(--ok-deep)` (zero, pos —
   positive keeps the leading `+`); `.sub`: negative **„Nedoplatok — po zaplatení sa
   zostatok vyrovná do 1–2 dní.“** (`OPEN:` PO confirms the 1–2 dní promise; default keep
   verbatim), otherwise **„Všetko vyrovnané.“**; negative ⇒ `button.btn.accent.block`
   **„Zaplatiť {fmtEur(-balance)}“** → PaymentModal exactly as UC-PI-008. Loading `.sub`
   „Načítavam...“; error `.banner.danger.slim` (shipped copy).
2. **Ledger** — new `components/FriendTransactionList.vue`: the row markup lifted
   VERBATIM from `FriendTransactionsModal.vue` (`.suborder > ul.items > li`, testids
   `tx-list`, `tx-row`, `tx-type`, `tx-meta`, `tx-amount`, the `overflow-wrap:anywhere`
   container, the `amount > 0` colour predicate, `sk-SK` date, type labels Platba /
   Účtovanie / Kredit), fed by `api.getTransactions(friendId)` on view mount; empty
   **„Žiadne transakcie“**; loading/error copy as shipped. `FriendTransactionsModal.vue`
   is **deleted** (no caller left).

⚠ **PI-T7 AMENDMENT (2026-09-20) — WHERE THE FETCH AND THE MOUNT ACTUALLY LANDED, and
neither is in this card.** Item 1 above said „one home for the balance fetch"; that half
is struck, because §UC-PI-008 gives the SAME debt a second surface on a DIFFERENT view.
A `PaymentModal` mounted inside this card cannot be opened from the landing's banner, and
the second mount that would fix that is exactly what §UC-PI-008's „Relocated, never
duplicated" forbids. So `FriendPortalSession.vue` holds the ONE
`api.getFriendBalance()` call, the ONE balance `<PaymentModal>` and `openBalancePayment()`;
this card takes `balance` / `payment` / `loading` / `error` as PROPS, emits `pay`, and owns
the one `data-testid="pay-balance"` control, while `DebtBanner.vue` (three landing call
sites, the `balance < -0.01` gate written once inside it) owns `debt-banner-pay`. Both call
that one function. What the card DOES keep as a one home is the three-state derivation —
the deleted modal's duplicate copy of it went with the modal. Counts are pinned in SOURCE,
per file, in `portal-balance.spec.js` §6: a second mount is invisible in any DOM.
⚠ The card's money classes follow the canon here, not module 03: `portal2.jsx:232` and the
text above both say ONE `.display` at 38px, and `.display.neg` is not available as a
compromise — `friends-theme.css:216` declares `.neg{font-family:var(--font-mono);
font-size:13px}` after `:25`'s `.display` at equal specificity. `.neg.pill` and `.zero`
consequently have no renderer left in `frontend/src`.

**Business rules:** `fmtEur` everywhere (dot decimal, ` EUR`); `BalanceBadge.vue` stays
untouched (admin-shared); no admin view imports anything from here. The view reloads
balance + transactions on mount (a payment marked by the admin shows after re-entering the
view — no polling). ⚠ **That is NOT in tension with §UC-PI-004's „one request per session
load" (PI-T7):** the latter is about the LANDING, so that the drawer badge costs nothing
per menu open, and `payment-links.spec.js` pins the landing count at exactly **1**;
entering this view is a deliberate navigation to the screen whose subject is the number,
and it re-reads. Implemented as a `watch` on `view` firing only on `shop → balance`, so a
cold load of `/zostatok` still reads once.

**Acceptance criteria:** −74.24 ⇒ red display amount, Nedoplatok copy, Zaplatiť 74.24 EUR;
0 ⇒ „0.00 EUR“ green + „Všetko vyrovnané.“, no button; rows with the pinned testids and
the sign/colour rule; 320 px: an unbreakable cycle name does not scroll the page
(`documentElement.scrollWidth === clientWidth`).

---

## UC-PI-011 Zdieľať s kolegami — the two new entry points (Friend, host)

**Goal:** the share row on the cycle card (03 UC-FL-007) is gone; sharing moves to the
cartbar icon + the drawer item. The dialog itself is module 05's (UC-KG-006), untouched.

**Business rules:**

- ONE `GuestShareDialog` instance in `FriendOrder.vue` (as shipped, `:open`, `:cycle-id`,
  `:cycle-name`, `@update:open`); the session view opens it through a `defineExpose`d
  `openShareDialog()` on the embedded FriendOrder (the drawer item calls it); the cartbar
  icon sets the same flag. Accessible name of both triggers: **„Zdieľať s kolegami“**
  (the cartbar icon via `aria-label`; the drawer item's `.lab` text). ~~Both exist ONLY
  when `state === 'open'` (locked/closed ⇒ count 0 — 05 UC-KG-002 rule).~~ **GL-T6c
  (19 §UC-GL-008): the CARTBAR icon exists only when `state === 'open'`; the DRAWER item
  also exists on the locked / closed-with-catalogue landings, where it reaches the
  read-only `FriendOrder` mount's instance (`shareHost`) and the dialog is standing-only
  (`cycleId = null`) — 05 UC-KG-002 still holds for the PER-CYCLE link.**
- The Kolegovia panel's own share card/buttons („Zdieľať odkaz“, „Zdieľať objednávku
  s kolegami“ — 05 UC-KG-001/002) are **unchanged** — three entry points, one dialog.
- Escape closes the dialog (`role="dialog"` count 0), `loadSeq` guard inside the dialog is
  05's; the landing never mounts a second dialog instance.
- Standing copy of module 14 UC-GR-009 renders unchanged.

**Acceptance criteria:** open round ⇒ cartbar icon + drawer item present; both open the
dialog titled with the current cycle's name; URL stays `/`; ~~locked ⇒ neither exists~~ **GL-T6c: locked ⇒ no cartbar icon; the drawer item opens the standing-only dialog (learnings 11 §GL-T6c)**;
~~`share-dialog.spec.js` passes unmodified~~ **— SUPERSEDED by PI-T3 (2026-09-20). It
could not: that file's entry point B is `openFromPortal()`, built on `portalCard()` =
`div.card.p-4` + the cycle's `<h3>`, i.e. the CARD this UC retires. NINE call sites were
re-pointed at the landing's `.cartbar` icon, under case (a) — the accessible name
(„Zdieľať s kolegami") is unchanged, so what moved is the locator, not the contract.
`guest-order-recovery.spec.js` carries the SAME helper and is named in no list at all
(a `grep "div\.p-4"` misses it — it writes `div.card.p-4`). The surviving claim: the
dialog's own behaviour is untouched, and both files pass with only their entry point
re-pointed.**

⚠ One consequence of the retarget, recorded because it decided a design question: the
cartbar icon is **landing-only**. `guest-host-view.spec.js:890,929` and
`share-dialog.spec.js`'s mount-seam test assert an UNSCOPED
`getByRole('button', { name: /Zdieľať/ })` on `/cycle/:id` — count 0 on „Moja
objednávka", count 1 on „Kolegovia". An always-visible icon makes those 1 and 2;
mutation-measured at 10 reds across the two files. The deep link keeps module 05's
Kolegovia card as its entry point.

---

## UC-PI-012 „Ako to funguje“ — explainer content and structure (Friend)

**Goal:** F3.3 + §13: the full-screen explainer, copy per prototype with the §16 fixes.
Illustrations are inline SVG (`NeoIcon` additions: `pause`, `bell`, `cup`, `truck`, `box`,
`hand`, `pin`, `menu`, `bag`, `list`, `wallet`, `help`, `user` — from `portal2.jsx I2`),
self-hosted, no external request.

**Structure (`/ako-to-funguje`, page column, `gap:18px`):**

1. `<h1 class="h-screen">Káva pod<br /><span class="p2-hl">pultom</span>, spolu.</h1>` (40/52 px).
2. `p.sub` 15px: **„Podpultovka je spoločná objednávka výberovej kávy pre okruh priateľov.
   Raz za pár týždňov otvoríme objednávky, nakúpime priamo v pražiarni za lepšiu cenu a
   rozdáme si to medzi sebou.“**
3. **Six phases** (`.p2-step`, numbered `.n` 1–6, `.display` 20px title + `.sub` 14px):
   1 **Pauza** — „Väčšinu času sa neobjednáva. Ponuku si môžete prezrieť, košík je zamknutý.“
   2 **Ohlásenie objednávky** — „Pár dní vopred sa dozviete, kedy sa objednávky otvoria. V appke aj cez WhatsApp.“
   3 **Objednávanie** — „Zvyčajne 5–7 dní. Naklikáte si kávu, odošlete, do uzamknutia môžete meniť.“
   4 **Čakáme na pražiareň** — „Objednávky uzavrieme, kávu objednáme. Praží sa na čerstvo, trvá to okolo týždňa.“
   5 **Balíme** — „Káva dorazila, každému zabalíme jeho objednávku. Vtedy je čas zaplatiť.“
   6 **Odovzdanie** — „Vyzdvihnete si ju na odbernom mieste, od priateľa alebo príde Packetou.“
   (Static text owned here; the LIVE timeline is module 17's component and is not mounted
   in the explainer.) `OPEN:` the WhatsApp mention in phase 2 — default keep (the PO already
   messages friends on WhatsApp personally; module 21 automates it).
4. **„Ako sa ku káve dostanete“** (`field-lbl` + three `div.card.flat` „Way“ rows, each
   icon + `<b>` title + `.sub` + trailing badge):
   - **Odberné miesto v Bratislave** — `{active pickup locations for coffee, "name (address)" joined by " · ", address omitted when null}. Vyberáte pri objednávke.` — badge `ok` **zdarma**. Source: `api.getPickupLocations('coffee')` (public); empty list ⇒ „Odberné miesto si vyberáte pri objednávke.“
   - **Cez priateľa** — **„Objednávate cez odkaz od priateľa? Kávu prevezme on/ona a odovzdá vám ju.“** — badge `ok` **zdarma**.
   - **Packeta** — **„Nie ste z Bratislavy? Objednajte si a nechajte poslať cez Packetu — na ľubovoľný Z-BOX alebo výdajné miesto.“** (§16 corrected sentence) — badge `acc-o` **„+{fmtEur(parcel_fee)}“** when `(currentCycle ?? catalogCycle)?.parcel_enabled`; otherwise no badge.
   R3.4.1 is DROPPED: the explainer recommends, nothing restricts free-text pickup.
5. **„Kto sme a odkiaľ je káva“** (§13): `.sub` origin paragraph — **„Podpultovka vznikla ako
   jedna objednávka pre pár kamarátov. Nie je to obchod — je to okruh známych a známych ich
   známych, len na pozvánku. Káva pochádza z dvoch zdrojov, podľa značky na karte
   produktu:“** (`OPEN:` PO writes the final text; this is the prototype placeholder) +
   one `div.card.flat` per roaster from **`lib/roasters.js`** (UC-PI-014): `span.badge`
   (+`acc-o` for Robo) + `.sub` text.
6. **„Ako platím“**: `.sub` **„Po zabalení dostanete sumu a QR kód. Zaplatíte jedným
   klepnutím cez <b>Revolut</b> alebo <b>bankovú appku</b> (PayMe), alebo prevodom na účet.
   Bez hotovosti.“** (PayMe arrives with module 15 — `OPEN:` hide „(PayMe)“ until 15 ships;
   default keep, 15 is scheduled before this module in roadmap v3 order 2 < 6.)
7. **Personal note** `div.card.flat` (`background:var(--accent-soft)`): avatar box „K“
   (`.display`, 44×44, ink) + **„„Podpultovku robím vo voľnom čase pre kamarátov a
   kamarátov kamarátov. Ak čokoľvek nesedí, napíšte mi na WhatsApp.“ — Karol“**
   (`OPEN:` PO's final wording; hardcoded, not a setting).
8. **Actions:** when opened as the first-login gate (UC-PI-013): `label` with
   `NeoCheckbox` **„Už mi to neukazovať“** (pre-ticked — resolved conflict 3) +
   `button.btn.accent.block` **„Rozumiem, idem na ponuku“**. When opened from the menu or
   the closed modal: the button only, labelled **„Späť na ponuku“**.

**Business rules:** impersonal vy-form throughout (no participle addresses the reader —
„dozviete“, „naklikáte“ are finite verbs, allowed); no external assets; the page is a
friend surface behind login (Q3.b: no public page). `getByRole('heading', { name: /Káva pod
pultom, spolu\./ })` resolves (the `<br>`/span concatenate). ⚠ **THAT REGEX DOES NOT
RESOLVE — measured in PI-T8 and corrected here.** The heading is
`Káva pod<br /><span class="p2-hl">pultom</span>, spolu.`, and Chromium's accessible-name
computation inserts a space at EVERY inline boundary — including between `</span>` and the
comma — so the real name is „Káva pod pultom **,** spolu." with a space BEFORE the comma.
The criterion is therefore `/Káva\s*pod\s*pultom\s*,\s*spolu\./`, which is what
`portal-explainer.spec.js` pins, alongside a `.p2-hl` assertion so the highlight span is not
silently dropped to make the name tidy. ⚠ The markup is NOT to be changed to satisfy the
old pattern: the `<br>` and the highlight are the prototype's. 320 px: zero horizontal
overflow with a 120-char pickup-location name.

---

## UC-PI-013 First-login gate — `explainer_seen_at` (Friend, system)

**Goal:** §3.3: shown once per friend after the first successful login; reachable from the
menu afterwards.

**Schema:** `friends.explainer_seen_at DATETIME` (nullable) via the `try/catch ALTER`
pattern (01-architecture §Roadmap additions). Existing friends ⇒ `NULL` ⇒ they see the
explainer once at their next login (`OPEN:` back-fill existing friends with `datetime('now')`
so only newcomers get the gate — default **no back-fill**: the feature exists because the
existing circle was never told how it works either).

**Route — `POST /api/friends/:id/explainer-seen`** (`routes/friends.js`,
`requireFriendOwner`; no body read, so unbindable bodies are irrelevant):
- 401 via `requireFriendOwner` (shared-password `friendId: null` is a **401**, same message
  as the contact gate friends.js:1015 — a write under an unresolved identity would stamp
  whoever's id is in the URL);
- 404 unknown/inactive friend (`'Priateľ nebol nájdený alebo je neaktívny'`) — ⚠ **measured in
  PI-T9: this branch is UNREACHABLE for an unknown id.** `requireFriendOwner` compares the
  session's `friendId` to the URL id BEFORE the row is looked up, so another friend's id and
  a nonexistent id both answer **403**. What the 404 still covers is the friend's OWN id
  after the row was deactivated or deleted mid-session. A test aimed at „unknown → 404"
  measures the 403 instead; the shipped spec asserts 403 and says so in its title;
- `UPDATE friends SET explainer_seen_at = COALESCE(explainer_seen_at, datetime('now'))
  WHERE id = ?` — **idempotent**, never moves an existing timestamp;
- 200 `{ explainer_seen_at }`. `api.js`: `markExplainerSeen(friendId)`.
- Joins `FRIEND_IDENTITY_ENDPOINTS` in `api-security.spec.js` (never `ADMIN_ENDPOINTS`).

**Login payloads:** every login response's hand-picked `friend` object gains
`explainer_seen_at`: `friends.js:173` (username branch), `:230` (shared-password branch),
`:358` (`/auth/google`), `magic-link.js:406`. Guard: `grep -n "friend: {" backend/src/routes/*.js`
must show the field on each friend-login site (orders.js:111/262 are order payloads, not
logins — untouched). `GET /friends/:id/profile` already returns it (`SELECT *` +
`sanitizeFriend`, which strips credentials only).

⚠ **There is a FIFTH session-minting site and it is deliberately not on this list:**
`routes/onboarding.js` (invitation registration) mints a friend session but returns no
`friend` object at all — `OnboardingPage.vue` builds `gorifi_friend_auth` from its four
flat fields and routes to the portal, so the newly registered friend arrives by the
**restore** path, which the client rule below says is not a login. Consequence, accepted:
a friend does NOT meet the explainer on the visit they registered in; they meet it at
their next ordinary login, stamp still NULL. Adding the field to that payload would not
help — it would make every reload re-open the gate. If the product wants the explainer on
the registration visit the fix is a ROUTE, not a field. (The `grep -n "friend: {"` guard
above does not see this site precisely because there is no `friend: {` in it — which is
why the exception is written down rather than left to the grep.)

**Client rules:**

- `beginSession({ …, explainerPending })` — `true` iff the handshake came from a **login
  response** with `explainer_seen_at === null`. A **session restore is not a login**
  (10 §UC-GA-006 precedent) and never sets it, even though `hydrateCurrentFriend` later
  learns the value — no auto-open on reload.
- `explainerPending` ⇒ the session's initial view is `explainer` (URL replaced to
  `/ako-to-funguje` via `router.replace` ~~so back goes to `/`~~ — ⚠ **the stated reason is
  backwards, AND the first correction of it (mine) was also wrong. The checkable reason,
  measured:** `push` would leave a **ONE-TAP BYPASS OF THE GATE**. `explainerGate` is raised
  once, at setup (`ref(!!props.entry?.explainerPending)`), and the exit watch lowers it on ANY
  transition out of the explainer view. So under `push`: back → `/` → `view` becomes `shop` →
  the watch fires → the gate is over, **unstamped**, and it cannot re-raise because the ref is
  only computed at setup. `replace` removes the `/` entry instead, so that tap is not there.
  ⚠ Note what `replace` does NOT do: it does not remove `/ako-to-funguje` from history — after
  „Rozumiem" pushes `/`, back returns to the explainer. That is harmless (the gate has already
  lowered and the write already happened) but it is why „so back goes to `/`" and „so the
  friend cannot be bounced into a URL they never asked for" are both false), with the checkbox row
  (UC-PI-012 item 8). „Rozumiem, idem na ponuku“ with the box **ticked** ⇒
  `markExplainerSeen` (fire-and-forget, error swallowed — the UX must not block on it) then
  `/`; **unticked** ⇒ `/` without the call (shown again next login).
- The forced-password gate (03 UC-FL-012) and the Google link prompt (10 §UC-GA-006) take
  precedence: the explainer view waits underneath them (they are modals over any view).
- Opening the explainer from the menu never writes anything; the drawer item is available
  in the explainer view only via the back chevron (UC-PI-003).

**Acceptance criteria:** fresh friend logs in ⇒ lands on `/ako-to-funguje`, „Rozumiem“
(ticked) ⇒ `/` + `POST …/explainer-seen` fired once; second login ⇒ straight to `/`;
reload with `explainer_seen_at` NULL ⇒ `/` (no auto-open); second POST returns the SAME
timestamp; anonymous POST ⇒ 401.

---

## UC-PI-014 Roasters — one home `lib/roasters.js` + card badge popover (Friend)

**Goal:** §13: the two coffee sources are described once and rendered in the explainer, on
the product card badge and (module 19) on the guest link.

**`frontend/src/lib/roasters.js`:**

```js
export const ROASTERS = [
  { key: 'goriffee', match: /^goriffee$/i, label: 'Goriffee', badgeClass: '',
    text: 'Pražiareň — stály základ ponuky. Espresso aj filter, čerstvo pražené na objednávku.' },
  { key: 'robo', match: /^robo$/i, label: 'Robo', badgeClass: 'acc-o',
    text: 'Domáci pražič. Hľadá zelenú kávu s vysokým hodnotením SCA (Specialty Coffee Association) a praží ju sám, v malých dávkach — všetko pod jeho značkou je ručne pražené doma.' },
]
export function roasterFor(name) { /* first ROASTERS entry whose match tests String(name).trim(); else null */ }
```
`OPEN:` both texts are prototype drafts — PO polishes (Q13.a: badge stays „Robo“, no
„domáce praženie“ variant).

**Business rules:**

- The explainer (UC-PI-012 item 5) iterates `ROASTERS`; the product card badge
  (`FriendOrder.vue:1479` `product.roastery` → `span.badge.acc-o`) becomes
  `span.badge` + `roasterFor(product.roastery)?.badgeClass ?? 'acc-o'` (Goriffee plain,
  Robo `acc-o`, unknown roasteries keep today's `acc-o`), `role="button" tabindex="0"`
  **only when `roasterFor()` matches**, click/Enter → a small `NeoModal` (`title` =
  roaster label, body `.sub` = text, footer `button.btn` „Zavrieť“). Unknown roastery ⇒
  inert badge as today. One modal instance in `FriendOrder.vue`, `v-if`-mounted.
- Guest surfaces (module 19) import the same file — never a second copy of the texts.
- Admin surfaces never import it (roastery admin keeps its own data).

**Acceptance criteria:** a product with roastery „Robo“ shows an `acc-o` badge that opens
the Robo modal; „Goriffee“ ⇒ plain badge + Goriffee modal; roastery „Foo“ ⇒ `acc-o`, no
role, no modal; the explainer's two cards carry the same two texts (asserted equal via the
module's exported strings).

---

## UC-PI-015 Profile modal per roadmap §19 (Friend)

**Goal:** the modal absorbs the friend's contact identity; `friends.name` is never called a
login; no uid.

**Trigger:** drawer → Profil (UC-PI-004). Composition unchanged: `NeoModal`
`title="Upraviť profil"`, footer „Zrušiť“ / „Uložiť“ (+„Ukladám...“), errors as
`.banner.danger.slim` in the body (03 UC-FL-009).

**Field group (body, top to bottom):**

| # | Label | Control | Required | `maxlength` (mirrors server) | Help (`div.field-help`) |
|---|---|---|---|---|---|
| 1 | **Login** | read-only `div.copyrow > div.val` (`data-testid="profile-username"`, `aria-labelledby`), rendered only when `friend.username` exists | — | — | **„Meno, ktorým sa prihlasujete. Nemení sa.“** (resolved conflict 4) |
| 2 | **Meno a priezvisko *** | `input.inp#pp-profile-name` | yes (trimmed non-empty; Uložiť disabled otherwise — shipped) | 120 (`MAX_NAME_LENGTH`) | **„Celé meno. Uvádza sa na zásielke pri doručení Packetou a vidí ho správca aj kolegovia.“** (unchanged) |
| 3 | **Mobil *** | `input.inp#pp-profile-phone`, `type="tel"`, placeholder `+421 900 000 000` | **yes — NEW** (trimmed non-empty; Uložiť disabled otherwise) | 32 | **„Pre koordináciu objednávky a odovzdanie.“** |
| — | *(module 21 inserts the WhatsApp opt-in `NeoCheckbox` row HERE, directly under Mobil — seam; nothing rendered by this module)* | | | | |
| 4 | **E-mail** | `input.inp#pp-profile-email`, `type="email"`, no placeholder | no | 160 | **„Voliteľné. Packeta naň posiela informácie o zásielke; slúži aj na obnovenie prístupu.“** |
| 5 | **Adresa Packeta výdajného miesta** | `input.inp#pp-profile-packeta`, placeholder `napr. Z-BOX Hlavná 15, Bratislava` | no | ~~— (no server bound today; `OPEN:` add 160)~~ **160 — RESOLVED (PO 2026-09-19) and SHIPPED by PI-T10** | **„Predvolená adresa pre doručenie Packetou (voliteľné).“** |
| 6 | Zmeniť heslo fold | as shipped (03 UC-FL-009), `v-if="friend?.hasCredentials"` | | | |
| 7 | Google section | as shipped (module 10) — untouched | | | |

Removed: the **„Jedinečné ID“ / uid** box (already absent since FUP-T20 — now a §19
requirement: `getByTestId('profile-uid')` count 0, the text „Jedinečné ID“ absent).

**Business rules:**

- `saveProfile()` sends only changed fields (shipped open-time-original diffing) —
  `{ name, phone, email, packeta_address }` to `PATCH /friends/:id/profile`. Server
  additions: `phone` present and blank (`''`/`null`) ⇒ **400 `{ error: 'Zadajte mobilné
  číslo', field: 'phone' }`** (this route only; the admin PATCH may still clear a phone);
  the shipped contact gate (401 when identity is unresolved, friends.js:1015) stays; the
  blank-name message `'Meno a priezvisko je povinné'` is a **server** string (⚠ FUP-T21
  relabelled it from `'Prihlasovacie meno je povinné'` — the old copy named the label
  FUP-T20 retired; it is now byte-identical to `POST /api/friends`, so re-wording one means
  re-wording both) and is **not rendered from the view** — the view's own client signal for
  an empty name stays the disabled button; ⚠ do not echo that server string into
  `FriendPortalSession.vue`.
- A friend whose stored `phone` is empty can open the modal and see „Mobil *“ empty;
  Uložiť is disabled until they fill it. ~~`OPEN:` auto-open the profile modal on login for
  friends without a phone — default **no**.~~ **RESOLVED (PO 2026-09-19): YES, and SHIPPED
  by PI-T10.** The rule as built:
  - **The trigger is a LOGIN, not a session mount.** `beginSession({freshLogin:true})` is
    passed by the THREE login paths only, exactly like `explainerPending`; neither restore
    path passes it, so a reload and a deep link do **not** re-open it. ⚠ This DEPARTS from
    the orchestrator's 2026-09-19 note („a reload therefore re-opens it"), on the wording
    of clarification (c) itself („re-opens on the next **login**"), on §UC-PI-013's stated
    boundary („a restore is not a login … must not be dragged into it by every reload")
    and on a measured cost: a session-mount trigger exposes **53** spec files to an
    unasked-for modal, a login trigger **16** — the population PI-T9 already contains.
    Both halves are pinned in `portal-profile-modal.spec.js` (a login opens it, a reload
    of that same session does not).
  - **Dismissal is per session**: `profileAutoOpenArmed`, a plain `ref` on the session
    side of `:key="sessionSeq"`, lowered when the modal opens. No persistence.
  - **The decision waits on `hydrateCurrentFriend`**, because `phone` is in none of the
    login payloads (PI-T9 pinned that set and PI-T10 did not extend it). The gate is
    `hasOwnProperty(friend,'phone')` — a truthiness test would flash the modal open for
    every friend during the hydrate window. A failed hydrate therefore never auto-opens.
  - **Precedence is CODED here**, unlike PI-T9's explainer (learnings 10 §PI-T9.10): the
    explainer is a VIEW that a modal paints over, this is a `NeoModal` that would STACK on
    a gate the friend cannot dismiss. ⚠ **The predicate is a CLASS — „every surface that
    raises itself without the friend asking" — not „the gates clarification (c) names".**
    ⚠⚠ The list was wrong in review TWICE (round 1 missed the landing state modals, round 2
    the voucher overlay), so it is **DERIVED, not maintained by hand**: walk every overlay
    MOUNT in the component and ask „can it raise with NO friend action?" **SEVEN** can:
    `forcedPasswordChange` (§UC-FL-012) · `showCredentialSetup` (§UC-FL-011) ·
    `showGooglePrompt` (10 §UC-GA-006) · `explainerGate` (§UC-PI-013) ·
    **`showClosedModal` / `showLockedModal`** (§UC-PI-006/007 — the landing STATE modals,
    and the COMMON case: `closed` is the normal state for most of the month) ·
    **`showVoucherModal`** (05 — `onMounted` awaits `checkPendingVouchers()`; its `z-50`
    teleport sits UNDER the `z-index:200` modal layer, so the profile form paints over a
    one-shot irreversible decision — measured `elementFromPoint` → `INPUT.inp`).
    Plus **`showProfileModal`**, a term of a different kind: not self-raising but possibly
    already OPEN, and `openProfileModal()` re-seeds every field, so a late hydrate would
    wipe what the friend was typing.
    ⚠ `portal-profile-modal.spec.js` PINS THE WALK IN SOURCE — every mount must be a term
    or a documented non-term — so an EIGHTH self-raising overlay reds instead of stacking.
    Only the 1st, 3rd and 4th are in clarification (c); each of the others is pinned by a
    test that reds when that one term is deleted. NOT terms (each checked):
    `showInviteModal` / `showBalancePayment` / the drawer need a click;
    `showPasswordChange` / `showPasswordSet` are folds inside this modal;
    `showMagicPrompt` is a `.banner`, not a modal.
  - **The state modal WINS, and the profile modal queues behind it** — clarification (c)'s
    „runs AFTER … resolve". Every term is a `computed`/`ref` that clears in place, so the
    profile modal arrives the moment the friend dismisses whatever was there.
- ⚠ **`#pp-profile-name` had no `maxlength` at all** until PI-T10 added the 120 this table
  always claimed — measured, not assumed (the field-contract test reddened on
  `maxlength=null` while phone/e-mail/Packeta were mirrored). CLAUDE.md's mirror rule had a
  hole on the one field the table calls required.
- The grep guard **holds and widens**: `grep -i prihlasovac frontend/src/views/AdminFriends.vue
  frontend/src/views/FriendPortalSession.vue` returns nothing (CLAUDE.md; pinned by
  ~~`portal-profile-modal.spec.js:424`~~ **BY NAME, not by line — see item 10: the test is
  „the grep guard itself: both views that edit `friends.name` are clean", and the DOM copy
  sweep „the portal and the profile modal are free of /prihlasovac/i" beside it is the one
  whose non-vacuity anchor PI-T10 had to retarget**). ⚠ „Login“ as a label is about `friends.username`
  (the real login) — the rule forbids calling `friends.name` a login, which nothing here does.
- `E-mail` becomes required when Packeta is chosen at checkout — that rule belongs to the
  Spôsob prevzatia modal (04 UC-FO-010, R4.3 „same rule for friends“) and is **not**
  implemented here; recorded as a seam for the row that touches UC-FO-010 (`OPEN:` which
  module — default: module 20 when it extends the delivery choice).
- Login-screen label stays „Užívateľské meno“ (03 UC-FL-002); only the profile row says
  „Login“ (§19, newest).

**Acceptance criteria:** labels resolve via `getByLabel('Login')` (read-only value),
`'Meno a priezvisko *'`, `'Mobil *'`, `'E-mail'`, `'Adresa Packeta výdajného miesta'`;
`maxlength` 120/32/160 present; blank Mobil ⇒ Uložiť disabled; API `PATCH {phone: ''}` ⇒
400 field `phone`; saving a new name updates the drawer header immediately and rewrites
`localStorage.gorifi_friend_auth.friendName` (shipped side-effect); the grep guard test
stays green.

---

## UC-PI-016 Subscription filter retired (Friend)

**Goal:** R2.5 / §16: bakery is retiring; the cycle-type filter has nothing to filter.

**Business rules:**

- The gear (`[aria-label="Nastavenia odberu"]`), the „Nastavenia odberu“ `NeoModal`,
  `openSubscriptionModal`/`saveSubscriptions`, `subCoffee`/`subBakery`/`subSaving`
  and the handshake's `subscriptions` seeding are **removed** from
  `FriendPortalSession.vue` / `FriendPortal.vue`.
- **Kept:** `friend_subscriptions` table, `GET/PUT /api/subscriptions/friend/:id`
  (`routes/subscriptions.js`), `api.getSubscriptions/updateSubscriptions`, and the
  server-side filter in `GET /friends/cycles` (UC-PI-002). No schema change, no route
  removal, no data deleted.
- The copy „Ak nevyberiete nič, zobrazia sa všetky cykly.“ disappears with the modal
  (one of the „cykly“ strings, UC-PI-017).
- Admin surfaces that show subscriptions (`AdminFriends.vue` `subscriptions` column) are
  untouched.

**Acceptance criteria:** no element with text or label „Nastavenia odberu“ anywhere on the
friend surface; `PUT /api/subscriptions/friend/:id` still answers 200 with a friend token
(the endpoint survives); a friend subscribed to `['coffee']` still sees their ordered
bakery round in history.

---

## UC-PI-017 Vocabulary rule — „objednávka“, never „cyklus“ / „kolo“ (Friend)

**Goal:** §16 / 00-overview glossary: the words „cyklus“ and „kolo“ (any inflection) never
reach a friend. Admin UI may keep „cyklus“.

**Grep guard (must return NOTHING; joins the module's e2e as a Node test):**

> ⚠⚠ **SUPERSEDED by PI-T11 (2026-09-23) — both the command and its file list below are kept as
> history only.** The authoritative guard is the Node test in `portal-vocabulary.spec.js` §2:
> `e2e/helpers/vocabulary.js importClosure()` DERIVES the file set as the import closure of the two
> friend routes (`views/FriendPortal.vue`, `views/FriendOrder.vue`), strips comments with
> `source-pins.js stripComments()`, and sweeps with `vocabulary.js BANNED`. Three reasons, all measured:
> (1) **the literal `grep` does NOT return nothing** — its trailing `grep -vE ":[0-9]+:\s*(//|\*|<!--|\* )"`
> recognises only a comment's FIRST line, so every continuation line of a multi-line `<!-- … -->`
> that mentions „cyklus" is a hit; (2) **the list was wrong in both directions** — it named
> `PickupLocationPicker.vue`, which is imported ONLY by the admin `CycleDetail.vue` and
> `Distribution.vue` (not a friend surface; removed from the guard, and its absence from the closure
> is pinned), and it omitted ≥ 15 friend-reachable files (`DebtBanner`, `PortalExplainer`,
> `lib/history-badges.js`, `api.js`, …); (3) **the regex misses words it bans** — JS `\b` is
> ASCII-only, so the trailing `\b` after `á` never fires and „kolá" passes, and the alternation lacks
> „kolám"/„kolami"/„kôl". `BANNED` is the union with an explicit Slovak-letter boundary.

```
grep -rniE "cykl|\bkol(o|a|e|u|om|á|ách)\b" \
  frontend/src/views/FriendPortal.vue frontend/src/views/FriendPortalSession.vue \
  frontend/src/views/FriendOrder.vue frontend/src/components/FriendBalanceCard.vue \
  frontend/src/components/FriendTransactionList.vue frontend/src/components/PaymentModal.vue \
  frontend/src/components/GuestShareDialog.vue frontend/src/components/GuestSubOrders.vue \
  frontend/src/components/CartLineList.vue frontend/src/components/PickupLocationPicker.vue \
  frontend/src/components/neo/ frontend/src/lib/portal-state.js frontend/src/lib/roasters.js \
  frontend/src/lib/dates.js \
  frontend/src/components/LandingStateModal.vue \
  frontend/src/components/CycleTimeline.vue frontend/src/lib/cycle-stages.js \
  | grep -vE ":[0-9]+:\s*(//|\*|<!--|\* )"
```
⚠ **THREE files were missing from this list** and were added in the PI-T4 review:
`LandingStateModal.vue` is a friend surface carrying Slovak copy and sits OUTSIDE the
`components/neo/` directory the list already covers (PI-T4); `CycleTimeline.vue` and
`lib/cycle-stages.js` are module 17's and were never added (pre-existing). All three are
clean today, so this was a GUARD GAP, not a live violation — which is exactly the shape
CLAUDE.md §Documentation discipline names: a rule stated as a grep must enumerate EVERY
file, or it quietly stops covering the thing it was written for.

(the trailing filter drops code comments — English „cycle“ never matches „cykl“ anyway;
„kolegovia“ is excluded by the word boundary.) A DOM sweep in the new spec asserts
~~`/cykl|\bkol(o|a|e|u|om|á|ách)\b/i`~~ **`e2e/helpers/vocabulary.js BANNED`** (PI-T11 — see the
supersession note above) is absent from ~~`document.body.innerText`~~ **the APP copy —
`e2e/helpers/copy-sweep.js collectAppCopy()`, i.e. `innerText` + `placeholder`/`title`/`aria-label`/`alt`
with every `[data-user-copy]` subtree dropped (FUP-T22)** — on every view, state and modal of this module.

**Copy edits mandated (friend surface):**

| File:line (today) | From | To |
|---|---|---|
| `FriendPortalSession.vue:1363` heading „Objednávkové cykly“ | — | removed with the list (UC-PI-005) |
| `FriendPortalSession.vue:1385/1392` „Žiadne dostupné cykly“ / „Žiadne aktívne cykly“ | — | removed; landing empty copy is UC-PI-006's „Ponuka ešte nie je pripravená.“ |
| `FriendPortalSession.vue:1679` „…zobrazia sa všetky cykly.“ | — | removed with the modal (UC-PI-016) |
| `FriendPortalSession.vue:2350` voucher modal „Za tvoju objednávku z cyklu {name} ti patrí zľavový voucher.“ | | **„Za tvoju objednávku ({name}) ti patrí zľavový voucher.“** — copy-only; the voucher modal's markup, ty-form and look stay out of scope (00-overview) |
| `FriendOrder.vue:1025` „Späť na zoznam cyklov“ | | **„Späť na ponuku“** (UC-PI-018) |
| `FriendOrder.vue:1833` „…až do uzamknutia cyklu.“ | | **„…až do uzamknutia objednávok.“** |
| `GuestShareDialog.vue:182` share-sheet fallback „objednávkový cyklus“ | | **„objednávka“** |
| prototype tickers/banners „ĎALŠIE KOLO“, „z minulého kola“ | | rewritten in UC-PI-003/008 |

**Handed off (guest surface, modules 19/20 — listed so nothing is silently kept):**
~~`GuestOrderStatus.vue:168` „v tomto cykle“~~ **— DONE, shipped by CS-T4 (17 §UC-CS-008,
2026-09-20): it now reads „Objednávky sú uzavreté, objednávku už nie je možné upraviť."** —
~~`GuestOrder.vue:170` „Cyklus sa medzičasom uzamkol“~~ **— GONE, removed by GL-T2 with the
dead `closed` card variant it belonged to (19 §UC-GL-006: the listing never answers 410 `closed`
any more)** —, ~~`GuestProductGrid.vue:88` (:76 until GL-T5; „:73" was
stale) „V tomto cykle zatiaľ nie sú žiadne produkty.“. The guard's file list widens to the
two REMAINING files when 19 lands. ⚠ A third, server-side: `backend/src/routes/guest.js:216`
„Objednávanie v tomto cykle je už uzavreté." (since GL-T2 served by the submit's 409 ONLY — the
listing's 410 `closed` is retired) — left standing because
`19-guest-standing-link.md:208` pins it as the shipped message; see the PO note in
`docs/learnings/09-cycle-stages.md`.~~ **— ALL SWEPT by GL-T7 (19 §UC-GL-011, module-19 closeout):
`GuestProductGrid.vue` → „V ponuke zatiaľ nie sú žiadne produkty.“; `routes/guest.js` `CLOSED` and its
three siblings (submit race, edit 409, edit race) → „Objednávky sú/boli (práve) uzavreté, …“; 19's
rule-5 pin struck with a pointer. PO drafts, listed in learnings 11 §GL-T7. The guard now covers the
guest routes' import closure (`e2e/helpers/vocabulary.js GUEST_SURFACE_ROOTS`, `portal-vocabulary.spec.js` §6).**
⚠ **And a FRIEND-facing server set, found in PI-T11's review and handed to GL-T7** (the row routes
`guest-orders.js` strings to the GL/GP rows, so PI-T11 did not re-word them): `routes/guest-orders.js:197` („Cyklus je už uzavretý, objednávku kolegu už nie je možné odstrániť.") and `:238` („Cyklus bol práve uzavretý, …odstrániť.") — the HOST's `DELETE /api/guest-orders/:id` 409s (not-open + the lost-race re-check), which DO reach a friend: `GuestSubOrders.vue removeSubOrder()` → `error.value = e.message` → the `.banner.danger.slim` at `GuestSubOrders.vue:378-380` on the Kolegovia tab of `FriendOrder`; plus `:525`/`:562` („…zrušiť.") on `POST /api/guest-orders/:id/cancel`, which is `requireAdmin` (only `CycleDetail.vue` calls it via `cancelGuestOrderAdmin`) and so may keep „cyklus" by the audience rule — named so the sweep decides both halves on purpose. **DECIDED by GL-T7: the two HOST 409s → „Objednávky sú už uzavreté / boli práve uzavreté, objednávku kolegu už nie je možné odstrániť.“ (PO drafts); the two ADMIN cancel 409s KEEP „Cyklus“ (audience rule) — both halves pinned in `portal-vocabulary.spec.js` §6.**

**Not covered (by design):** `routes/*.js` error strings a friend may see (e.g.
`'Cyklus nie je otvorený'`-style 409s) — `OPEN:` sweep server messages returned to friend
routes; default: sweep in the same row, message-by-message, keeping status codes.

---

## UC-PI-018 Deep links `/cycle/:id` keep working (Friend)

**Goal:** R1.7: share-row links, e-mails and the admin's links to a cycle must not break.

**Business rules:**

- `router.js` `/cycle/:cycleId` → `FriendOrder.vue` in `mode='route'` — the shipped
  standalone screen (04 UC-FO-001..015): own `.app` root, BrandChrome with back chevron,
  cycle name title, friend name subtitle, lock/Otvorené chip, tickers, locked banner +
  locked cartbar. Its auth restore from `localStorage`/memory stays (a deep link is
  opened cold).
- Back chevron and the fatal-error button navigate to **`/`** (the landing); the button
  reads **„Späť na ponuku“** (UC-PI-017). The chevron's `aria-label` stays **„Späť“**
  (learnings 03: substring match hazard).
- The `/cycle/:id` of the CURRENT open cycle renders the same grid as the landing; the
  landing is not a redirect to it (two routes, one component, one behaviour).
- A completed cycle's deep link renders read-only as today (04 UC-FO-014 treats completed
  as locked).
- The order success modal on the deep link closes to `/` (shipped).

**Acceptance criteria:** `page.goto('/cycle/<open id>')` with a stored session ⇒ the order
screen with its own chrome; back ⇒ `/` landing; `/cycle/<completed id>` ⇒ read-only,
„Späť na ponuku“ present in the fatal-error state for an unknown id.

---

## UC-PI-019 Verification — sanctioned e2e edits, new specs, admin invariance (system)

**Goal:** this module's e2e surface is the roadmap's stated risk (§1 Impact). Every edit
below is case (a) of the immutability rule (03 UC-FL-013 amendment): a spec mandates the
behaviour change, the assertion is re-pointed at the mandated structure, the protected
property is kept, and the code comment cites the UC. Enumerate the count of edited files
in the PR.

**1. Shared helper `e2e/helpers/portal.js` (NEW; every retarget below uses it, so a future
IA change edits one file):** `expectLanding(page)` = `expect(page.getByTestId('portal-landing')).toBeVisible()`;
`openMenu(page)` (click `.appbar [aria-label="Menu"]`, await `getByRole('dialog', { name: 'Menu' })`);
`menuGo(page, label)`; `logout(page)` (menu → „Odhlásiť sa“ → `.appbar .titles .t` „Podpultovka“ + `portal-landing` count 0);
`openProfile(page)` (menu → Profil → dialog `.m-title` „Upraviť profil“); `openInvite(page)` (chip).

**2. The „portal is ready“ gate — `getByRole('heading', { name: 'Objednávkové cykly' })` →
`expectLanding(page)` (UC-PI-005):** ~~29 files~~ — **DONE by PI-T1 (2026-09-20). The
enumeration below was STALE and is kept only as history; the measured figure is 30 files /
72 occurrences, of which 28 files / 60 occurrences were retargeted** (`portal-cycles` 7 and
`portal-share-row` 5 skipped — PI-T3 deletes both files). ⚠ **`payment-links.spec.js` is in
the real list and in neither this enumeration nor the backlog row** — it landed with PL-T4,
after this file was written, which is exactly why the re-enumeration instruction is here.
⚠ **`google-auth` is 1 occurrence but 19 call sites**: `const PORTAL_HEADING =
'Objednávkové cykly'` at `:1594` plus 18 indirect usages, invisible to a grep for the
assertion shape. Historical list: `magic-link` (14), `portal-cycles` (7 — file
retired, item 5), `friends-consolidation` (6), `portal-share-row` (5 — retired), `modern-login`
(4), `guest-link` (3), `order-modals` (3), `portal-appbar` (3), `portal-profile-modal` (3),
`order-locked` (2), `portal-session-boundary` (2), `portal-subscription-invite` (2), and one
each in `cat-scroll-arrow`, `catalog-admin`, `colleagues-panel`, `forced-change-ui`,
`google-auth`, `guest-host-view`, `guest-order-recovery`, `money-rounding`, `order-cartbar`,
`order-fidelity`, `order-product-card`, `order-shell`, `portal-fidelity`,
`portal-transactions-modal`, `product-desc-font`, `product-photo-lightbox`, `share-dialog`.
Where the heading's `toHaveCount(0)` proved a logout (`portal-appbar.spec.js:268`,
`magic-link.spec.js:1549`), assert `portal-landing` count 0 (`expectNoLanding(page)`).
Re-enumerate before editing: `grep -ln "Objednávkové cykly" e2e/tests/*.spec.js`.

**3. Portal → cycle navigation by clicking the card heading (UC-PI-018):**
~~`guest-link.spec.js:255`, `catalog-admin.spec.js:2419`~~ **— the enumeration was
STALE, like item 2's before it. Measured by PI-T3: the grep below hits TWENTY spec
files**, because `page.goto('/')` + the heading click was the ONLY in-app route to an
order screen and every order-surface spec used it — `cat-scroll-arrow`,
`colleagues-panel`, `guest-host-view`, `guest-link`, `guest-order-recovery`,
`guest-payment-modal`, `catalog-admin`, `money-rounding`, `order-cartbar`,
`order-fidelity`, `order-locked`, `order-modals` (×4), `order-product-card`,
`order-shell`, `payment-links`, `product-desc-font`, `product-photo-lightbox`,
`share-dialog`, `mobile-no-h-overflow`. **Re-enumerate before editing; never trust the
list.** The grep:
`grep -nE "heading', \{ name: [A-Za-z_.]+, exact: true \}\)\.click\(\)|getByText\((CYCLE_NAME|cycleName)\)\.click" e2e/tests/*.spec.js`

~~replace with `page.goto('/cycle/${id}')` + the shipped URL assertion~~ **— SUPERSEDED:
that does not work, and PI-T3 measured it.** The friend's Bearer token lives in MEMORY
only (`api.js setFriendsToken`); `FriendPortal.vue` is its single owner, so a COLD
document load of `/cycle/:id` finds no credential and `FriendOrder.onMounted` bounces to
`/` by design — which is why all twenty files went in through the portal to begin with.
The replacement is **`e2e/helpers/portal.js gotoCycle()`**, one home, which uses that
bounce instead of fighting it: `goto('/cycle/:id')` → the app's own `router.push('/')`
(a same-document `pushState`) → wait for the portal (the session restores the token) →
`goBack()`, a same-document traversal vue-router handles client-side. ⚠ Its one cost:
`/cycle/:id` becomes the BOTTOM history entry, so a test asserting the leave guard on a
history traversal uses `goForward()` — `goBack()` now leaves the document entirely
(measured: `about:blank`). `order-locked.spec.js` and `order-modals.spec.js` carry that
edit. ⚠ The underlying bounce contradicts §UC-PI-018's own acceptance criterion
(„`page.goto('/cycle/<open id>')` with a stored session ⇒ the order screen") — shipped
behaviour, untouched by PI-T3; **PI-T11 owns the decision**, and fixing it would let
`gotoCycle()` collapse back to a plain `goto`.

**4. Logout control (UC-PI-003/004):** `.appbar span[aria-label="Odhlásiť sa"]`
(`portal-appbar` ×6, `portal-session-boundary` ×3, `portal-profile-modal` ×2,
`portal-cycles`, `portal-share-row`, `friends-consolidation.spec.js:1006`) and
`getByRole('button', { name: 'Odhlásiť sa' })` (`google-auth.spec.js` ×12: 1686, 1714,
1736, 1915, 1963, 2002, 2011, 2067, 2579, 2640, 2664, 2754) → `logout(page)`.
`admin-auth.spec.js:48` is the ADMIN logout — untouched.

**5. `.appbar .titles` click → profile (UC-PI-003):** `portal-appbar` (tests at 237–269,
290–341: the `.titles` role/tabindex/aria-label/Enter/Space assertions INVERT to „no role,
no tabindex, no aria-label in the authenticated state“ — the login-state test at 343 becomes
the general rule), `portal-profile-modal.spec.js:155` (its `openProfile` helper →
`openProfile(page)`), `portal-session-boundary.spec.js:263`, `portal-fidelity.spec.js:377`,
`friends-consolidation.spec.js:850`, `magic-link.spec.js:1952`, `google-auth.spec.js:2253`
(and its header comment 2246). Pencil tests (`portal-appbar` 163–166, 176–235) → one
absence pin `[data-testid="profile-pencil"]` count 0.

**6. Retired spec files (structures gone):** `portal-cycles.spec.js` (cycle list, cards,
badges, archive, empty states, gear), `portal-share-row.spec.js` (share row, fan-out).
Delete them; their protected PROPERTIES move: share entry contract + `@click.stop`-equivalent
(URL stays `/`) → `portal-landing.spec.js`; the sequence guard on the colleague count
(logout drop, second-load drop) → `portal-menu.spec.js` (drawer item 4 sub); ~~locked/planned
⇒ no share affordance~~ → `portal-landing.spec.js` **(GL-T6c: now „no cartbar icon and no
per-cycle link; the drawer row opens the standing-only dialog")**.

**7. `portal-appbar.spec.js` — rewritten:** structure test → menu button + wordmark + view
subtitle + one `.chip.acc` „Pozvať“ + lock chip rules + tickers per state (the
`'ČLENSKÝ OKRUH'` pin at :140 → the three state tickers of UC-PI-003); the „Balance card“
describe (363+) and every `Môj účet`/`Transakcie` assertion → move to `portal-balance.spec.js`
as the Zostatok view; add absence pins for pencil, logout glyph, `.titles[role]`.

**8. `portal-subscription-invite.spec.js`:** the three subscription describes (174–365,
474–520) → replaced by two pins: no „Nastavenia odberu“ element on any view, and
`PUT /api/subscriptions/friend/:id` still 200 (UC-PI-016). The invite describe (369–472)
stays; it opens via `.appbar .chip.acc` — unchanged locator.

**9. `portal-transactions-modal.spec.js` → `portal-balance.spec.js` (rename):** open via
`menuGo(page, 'Zostatok a platby')`; `.m-title 'Všetky transakcie'`, `body > .modal-layer`
and `[aria-label="Zatvoriť dialóg"]` pins are structurally unsatisfiable (no modal) → the
list renders in-page; keep every `tx-*` row pin, the sign/colour rule, loading/empty/error
copy, the 320 px unbreakable-name test (measure the ROW and the PAGE now), and the admin
invariance describe (382–429) unchanged.
⚠ **DONE by PI-T7 (2026-09-20), with the accounting this item did not ask for and should
have.** 18 tests came in (11 from the modal file, 7 from item 7's appbar describe) and 23
are in `portal-balance.spec.js`: **11 kept**, **5 retargeted**, **2 dropped as
unsatisfiable** (the × / „Zavrieť“ NeoModal shell test — its „closing must UNMOUNT or the
scrim keeps eating clicks“ property is carried onto the balance `PaymentModal`; and
„„Transakcie“ opens the transactions modal“, whose button §UC-PI-010 removes), **7 new**.
Six more land in `portal-landing.spec.js` §8 (the debt banner in all three states).
⚠ Two things item 9 could not know: the drawer entry (`menuGo`) is pinned ONCE and the
rest of the file enters `/zostatok` by URL, because a `closed` landing auto-mounts
`LandingStateModal` and its scrim intercepts the appbar's Menu click; and the 320 px
test's OUTER measurement changed from the `.modal-scrim` to the DOCUMENT — in the modal
the scrim (`overflow-y:auto`, so `overflow-x` computes to `auto` too) absorbed every spill
and the document never moved, so copying that assertion verbatim would have measured
nothing.

**10. `portal-profile-modal.spec.js`:** `getByLabel('Užívateľské meno')` → `'Login'`;
`.field-help` nth(0)/nth(1) texts → the §19 table order (Login help first, then Meno,
Mobil, E-mail, Packeta); `Email` → `E-mail`; add „Mobil *“ required + `maxlength` +
API 400 tests; the FUP-T20 grep test (424) and the display_name test (494) stay verbatim;
`profile-uid` count 0 stays.
⚠ **DONE by PI-T10 (2026-09-21), and THREE of this item's figures were wrong** — the
sixth stale enumeration in this UC (items 2, 3 and 9 preceded it):
- ⚠⚠ **THE LINE NUMBERS ARE THE WRONG UNIT AND PI-T10 PROVED IT TWICE.** The item said
  424/494; the pre-edit tree said 467/538; the POST-edit tree — the one a reader opens —
  says **518** and **596**, because this row's own +51/+58 lines moved them. A
  re-measured line number is correct for exactly as long as it takes to land the diff.
  **Cite test NAMES.** The two that stay verbatim are „the grep guard itself: both views
  that edit `friends.name` are clean" and „the friend profile omits display_name; the
  admin list still carries it", and both did.
- ⚠ **The item names ONE test in that describe and there are TWO.** „the portal and the
  profile modal are free of `/prihlasovac/i`" is a DOM copy sweep whose NON-VACUITY
  anchor is `toMatch(/užívateľské meno/i)` — i.e. this item's own rename makes it red.
  Retargeted to `/\blogin\b/i` plus an absence half. The SOURCE grep is the one that
  stays verbatim, and it did.
- „`.field-help` nth(0)/nth(1)" became the whole FIVE-entry sequence plus a count and an
  input-order pin: an nth() pin that stops before the tail cannot see a field that moved
  past it, which is the exact failure a reorder invites.
- ⚠ **Unlisted consequence, found by running it:** the fixtures had to grow a PHONE.
  Three of this file's describes save the form or count dialogs after a card login, and
  a phone-less friend now meets the auto-open. `makeFriend`/`makePlainFriend` carry it,
  and so does the „unhydrated modal" test, which is now also the pin for „before
  hydration lands, this form cannot be saved at all".

**11. `friends-consolidation.spec.js`:** the 14 `'Bez e-mailu…'` help-text pins → the §19
E-mail help text; the `Mobil` label → `Mobil *`; item 2/4/5 sites.
⚠ **DONE by PI-T10, and „14" counts the wrong thing.** The grep really did return 14
occurrences — but only **ONE** was the friend-portal help text this item means, in
„field contract: labels, .inp skin, maxlength mirror, type=email, placeholder policy,
vy-form help". **ONE more** is the ADMIN modal's own hint, a DIFFERENT string („Bez
e-mailu sa **priateľovi** nedá poslať…"), pinned in „exactly 4 writable fields, exact
labels, maxlength mirrors the server bounds, truthful hints" — untouched. The other
**twelve** are the admin contact-cell BADGE „Bez e-mailu", which §19 does not touch at
all. Rewriting all fourteen would have deleted an admin surface's pins.
⚠⚠ **AND THIS PARAGRAPH ORIGINALLY GAVE THREE LINE NUMBERS, TWO OF THEM ALREADY WRONG —
three lines after item 10 records „cite test NAMES".** A lesson written down is not a
lesson applied; the habit is the thing. (For the record, the grep now returns **15**:
the retarget added an ABSENCE assertion for the string it replaced. A count restated in
prose ages the moment the file changes, which is the same defect one level down.)
⚠ Also unlisted: `getByLabel('Email')` → `'E-mail'` is REQUIRED (a substring matcher does
not find „Email" inside „E-mail"), `getByLabel('Mobil')` → `'Mobil *'` is not (it would
still match) but is done for truthfulness; the ADMIN-modal label list in „exactly 4
writable fields, exact labels, maxlength mirrors the server bounds, truthful hints“ keeps
„Mobil"/„Email" untouched; the API test „null clears" splits (the phone half is now a
400 and reads the row back); the slow-hydrate race test's „B's fields are empty" becomes
„B's own phone", a stricter statement of the same leak property; and every
`makeFriendWithSession` friend now carries a `uniquePhone()`.

**12. `guest-link.spec.js`:** :252 gate (item 2); :255 heading click (item 3); test
„host can share straight from the portal cycle card“ (291–327) → „…from the landing
cartbar“: `getByRole('button', { name: 'Zdieľať s kolegami' })` on `/` when the seeded
cycle is the current open one, URL stays `/`, dialog flow unchanged; the locked half
(306–311) → lock the seeded cycle via API, reload, assert count 0. Test „a slow load for
one cycle cannot overwrite the link shown for another“ (329–380) is structurally
unsatisfiable (one current cycle on the landing) → retarget: open the dialog on `/`,
Escape, `page.goto('/cycle/<B>')`, open there ⇒ B's link, never A's (the dialog's
`loadSeq`, 05 UC-KG-006, still the protected property).

**13. `portal-fidelity.spec.js`:** portal tests built on `div.p-4`, `cycle-date`,
`cycle-plan`, `archive-toggle` (216–261, 347–363) → retire; ADD landing equivalents:
A10 `line-height:normal` on `.banner.slim`, `.badge`, ~~`.display` inside `own-order-card`,
`.cs-tl .lbl`~~ **(these two are NOT A10 sites — the canon declares both; see the ⚠ DONE note
below)** (via 17's component — ⚠ the prototype's `.p2-` prefix was dropped when
CS-T2 shipped `CycleTimeline.vue`; 17 §UC-CS-006 always said `.cs-`), 320 px hostile text in `plan_note`/`expected_date`/
pickup note/cycle name on all three states. Login/modal tests stay (377 via item 5).
⚠ **DONE by PI-T12 (2026-09-23), and TWO of the four named sites are NOT A10 sites** — A10
covers only the classes the canon leaves line-height-SILENT, and these two the canon
declares: `own-order-card .display` is inline `lineHeight: 1` (`portal2.jsx:350/356`) and
`.cs-tl .lbl` is `1.25` (`portal2.css:31`; `1` on the „now" step, `:33`). Pinning them at
`normal` would have pinned a DRIFT. They are pinned at the canon's values instead, and the
timeline's real A10 site is a class this item does not name — `.when` (`portal2.css:34`,
silent). Measuring against the canon found THREE shipped drifts, all fixed: own-order
`.display` `.9` → `1` (19.8 → 22px), the history total's inline `.9` removed (canon silent ⇒
A10 `normal`), and `CycleTimeline.vue` `.when` 17.25px → `normal`. The 320 px pass found two
real overflows: the state modal's footer at every viewport below ~370px (static copy, no
hostile text needed) and the drawer (row sub-line + header name). See learnings 10 §PI-T12.

**14. `portal-session-boundary.spec.js`:** the surface walk (252–307) → drawer-based:
open every drawer item (history expand, balance, explainer incl. the checkbox, profile
fold, invite, share ~~when open~~ **when the landing hosts the dialog — open, locked, closed-with-catalogue (GL-T6c)**), close, `logout(page)`; invariants 1–4 unchanged; the
`setupSaving` Esc test unchanged. Header comment updated to name the drawer.
⚠ **DONE by PI-T12.** „The explainer incl. the checkbox" is TWO stops, not one: the
„Už mi to neukazovať" checkbox renders only on the first-login GATE (`asGate`), never on
the drawer's „Ako to funguje". So the modern-login test's two friends are left
unacknowledged and the walk starts on the gate; the drawer's explainer is a separate stop
that pins the checkbox's ABSENCE. The balance stop also opens the Platba modal.

**15. `self-hosted-fonts.spec.js`:** the `cycle-date` reference → a landing element
(`portal-landing`); the three new routes join its zero-external-requests sweep
(UC-PI-001). `ios-input-zoom.spec.js` „Pozvať“ — unchanged.

**16. `api-security.spec.js`:** `FRIEND_IDENTITY_ENDPOINTS += 'POST /api/friends/1/explainer-seen'`.
Nothing joins `ADMIN_ENDPOINTS` (no admin route in this module).

**17. New spec files (fixtures per test, never a shared `beforeAll`):**
- `portal-landing.spec.js` — resolver matrix (UC-PI-002 incl. two-open warning), open
  state (status line, share icon, no cycle list), closed state (modal once per session,
  banner, `.p2-ro`, tabs live, no cartbar, no stock bars), locked state (own-order card,
  paid/unpaid, PaymentModal amount, no-order variant), debt banner three balances, deep
  link back to `/`, „Skúsiť znova“.
- `portal-menu.spec.js` — items/order/conditional item 4, subs incl. cart total and
  balance badge, `.on`, teleport (`.app .p2-drawer` count 0), Esc/scrim/×, focus trap,
  seq-guard (deferred count response past logout / past reload dropped), logout footer.
- `portal-history.spec.js` — rounds list (hasOrder only), badge matrix, lazy lines with
  `li.ln`, per-row pending, empty state, no „Archív“.
- `portal-balance.spec.js` — see item 9 + account card states + Zaplatiť.
- `portal-explainer.spec.js` — content pins (six titles, three ways, roasters equal to
  `lib/roasters.js`, PayMe/Revolut sentence), pickup-point list from the API, Packeta badge
  gating, first-login gate (fresh login ⇒ `/ako-to-funguje`; ticked ⇒ POST once; unticked ⇒
  no POST; restore ⇒ no auto-open; idempotent timestamp; 401 anonymous), back chevron,
  menu absent in the explainer view.
- `portal-vocabulary.spec.js` — the grep guard (Node `execSync`, must be empty) + the DOM
  sweep across views/states/modals.

**18. Admin invariance (02 UC-DS-014 item 2):** no `pp-*`/`p2-*`/`neo/`/theme class under
admin views; `BalanceBadge.vue` untouched; `lib/roasters.js`, `lib/dates.js`,
`lib/portal-state.js` have no admin importer (`grep -rl "lib/roasters\|lib/dates\|lib/portal-state" frontend/src/views/Admin* frontend/src/views/CycleDetail.vue frontend/src/views/Distribution.vue` empty).

**Procedure:** `node --check` on changed backend files; targeted files first (the six new
specs + items 4–16's files), full suite only at the module milestone with `--workers=1`,
all five `RATE_LIMIT_*_MAX` raised, output to a file (CLAUDE.md §Running the e2e suite).
Dependencies before this module's rows run: module 17 (`opens_at/closes_at/stage`,
`CycleTimeline.vue`), module 16 (`handed_over_at`) for `orderHandedOver`; module 15 is
consumed if present (~~PaymentModal props frozen either way~~ — **PL-T3 superseded that:
the props are ADDITIVE, not frozen (15 §UC-PL-004/D4)**. The claim it was making still
holds in the form that matters here: a caller that passes neither `variableSymbol` nor
`creditorName` gets byte-identically what shipped, so this module's rows compile against
module 15 present or absent — they just have two more props to forward when it is present).

---

## Dropped / Phase 2 (named so nothing is silently implemented)

- **Public „Ako to funguje“ page** (Q3.b) — dropped by PO 2026-09-06; the guest link
  carries a 3-step explainer (module 19).
- **Tabs per open cycle type** (original R1.2) — dropped; one open cycle max.
- **Subscription (cycle-type) filter UI** — retired (UC-PI-016); column/endpoint kept.
- **Pickup-point policy R3.4.1** (who may use free text) — dropped; everyone keeps free text.
- **Preferred pickup point in the profile (R2.4 / R3.4.2 `friends.default_pickup_location_id`)**
  — not in this module (no source decision after 2026-09-04 confirms the column); `OPEN:`
  which module owns it — default: the invitation/registration module when R3.4.2 is picked up.
- **WhatsApp opt-in checkbox** in the profile — module 21 (seam named in UC-PI-015).
- **Balance-payment variable symbol / reference format** — module 15 (seam in UC-PI-008).
- **„Kde je vaša káva“ step model, labels, dots** — module 17 (consumed).
- **Portal delivery-method badge, separate kilos line** (03 dropped items) — stay dropped;
  the own-order card shows the pickup target (a different thing, UC-PI-007).
- **Cycle cards / archive fold / colleague-count fan-out** — retired with module 03's
  landing; not to be re-added as a „list view“.
- **Prototype demo strings** (`3. októbra`, `Neškôlka · Karlova Ves`, `-52.80`, „člen od
  2024“, `LEGO-9F2K`) — sample data, never hardcoded.

## PO decisions 2026-09-19 — OPEN items resolved

> Recorded by the orchestrator from the PO walkthrough. Each line resolves the `OPEN:` of the same name above; where a default was overturned the affected UC carries an amendment note.

- **Debt banner on landing** = YES; zero/positive balance only under Zostatok a platby.
- **Closed state** = modal once per closed period, then the yellow slim banner.
- **Explainer back-fill** = NO back-fill: EVERY existing friend sees the explainer once at their next login (dismissible with „Už mi to neukazovať“).
- **Profile modal auto-open** = YES for friends with empty `phone`, until Mobil is filled (Uložiť disabled meanwhile).
- **History „Otvoriť“ link** = NO (read-only surface).
- **Balance copy** = keep „po zaplatení sa zostatok vyrovná do 1–2 dní“.
- **„člen od {rok}“** = omitted. **WhatsApp mention in explainer phase 2** = keep.
- **„(PayMe)“ in „Ako platím“** = keep — module 15 ships before 18 (roadmap order).
- **Packeta address server bound** = add 160 (mirrored `maxlength`).
- **`closes_at` time part** = not displayed (date only).
- **Server messages sweep** = YES, friend-facing 4xx strings lose „cyklus“ (UC-PI-017).
- **Orchestrator clarifications 2026-09-19:** (a) „modal once per closed period“ = the spec's per-SESSION rule (`closedModalDismissed` in session state; a reload shows the modal again) — no persistence, no localStorage. (b) Explainer gate + existing e2e: `e2e/seed.mjs` pre-stamps `explainer_seen_at` for every seeded friend EXCEPT one dedicated fixture, so shipped login-then-land specs stay behaviour-identical and only `portal-explainer.spec.js` exercises the gate. (c) Profile auto-open (empty `phone`) runs AFTER the forced-password gate, the Google prompt and the explainer gate resolve; it is dismissible per session and re-opens on the next login until Mobil is filled.
