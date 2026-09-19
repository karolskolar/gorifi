# Podpultovka roadmap 2026-Q4 — requirements & sequencing (DRAFT for PO review)

**Date:** 2026-09-03, PO answers folded in 2026-09-04, revision 2026-09-06 (§11–§18), confirmations 2026-09-19 (F5 = whatsapp-web.js only; F7 out) · **Status:** requirements only, no code · **Author:** PO + Claude
**Source:** PO feature list (feedback from newly onboarded friends and their guests) + codebase audit.

This document turns seven raw feature ideas into scoped requirements, expands them where they drive
the business or user satisfaction, states what already exists in the codebase, lists open questions
(each with a recommended default), and proposes an implementation order. Section §9 says which items
I recommend *not* implementing as originally stated.

---

## 0. What the audit found (facts the requirements rest on)

| Area | Already in the code | Gap for the new features |
|---|---|---|
| Cycles | `order_cycles.status ∈ planned/open/locked/completed`, `plan_note` (free text), `expected_date`, `type` coffee/bakery, `parcel_enabled` + `parcel_fee` | No machine-readable *opening date*; no fulfilment sub-stage after lock (ordered at roastery → arrived → packing → ready) |
| Friend portal landing | `FriendPortalSession.vue`: balance card → cycle card list (active + archive fold) → click a card → `FriendOrder.vue` product grid. Appbar: name/uid (→ profile), pencil, "Pozvať" chip, logout; gear → subscriptions (cycle-type filter) | The *cycle* is the first thing a newcomer sees; the shop is one click away and unexplained |
| Guest flow | `/g/:token` lands directly on the product grid (good precedent). Guest = name + phone (+ optional email). Delivery = host hands over; pickup point lives on `guest_order_links` | No Packeta path for guests; email optional |
| Payments | `PaymentModal.vue` (shared by FriendOrder, GuestOrder, GuestOrderStatus, FriendTransactionsModal): Revolut *profile* link (`revolut.me/<user>`, no amount), bysquare QR, IBAN, server-owned reference (`guestPaymentReference` = `G<id> / name / cycle`) | No amount-prefilled Revolut link; no PayMe.sk link; no numeric variable symbol |
| Packing / distribution | `orders.packed`, per-item packed, `Distribution.vue` print sheet grouped by pickup point, Packeta group with address | No per-bag label; print sheet is a picking list, not labels |
| Notifications | `helpers/mailer.js` (transactional e-mail only) | No push, no WhatsApp, no outbox/queue, no consent flag, no phone normalisation (`phone` is length-validated only) |
| Onboarding | Invitation approval (module 07), Google auth (10), `OnboardingPage.vue` (bakery self-onboarding), `friends.onboarding_source`, rewards, coffee passport (13) | No "how it works" explainer anywhere; no first-login state |
| Pickup points | `pickup_locations` (name, address, active, for_coffee/for_bakery); admin can set any party's pickup (`helpers/pickup.js`); free-text `pickup_location_note` allowed | No instructions/hours/map; no policy on who may use free text |

---

## 1. F1 — Portal landing = the shop, not the cycle list

### Problem
Two freshly onboarded people (a friend and their guest) did not understand "objednávkové cyklus/kolo".
They have no history of past rounds, so a list of cycle cards is meaningless. The concept is *ours*
(inventory/accounting), not theirs. Guests already land on a product grid; friends should too.

### Requirements
- **R1.1 Landing = current offer.** Opening the portal shows the product grid of the *current* cycle
  directly, with the cart bar. No cycle card list on the landing.
- **R1.2 One offer at a time.** ~~Tabs per open cycle type~~ — **PO 2026-09-04: bakery cycles are
  retiring; only coffee remains.** The landing assumes at most ONE open cycle. If the data ever
  holds two open cycles, show the newest and log a warning. The subscription (cycle-type) filter is
  retired outright (see R2.5). Bakery history stays visible under "Moje objednávky".
- **R1.3 Closed state.** If no cycle is open, the landing still renders the grid (read-only, from the
  most recent cycle, stock badges hidden, add-to-cart disabled) behind a **state modal**:
  "Objednávky sú momentálne zatvorené." + one of
  - planned cycle with a date: "Ďalšie kolo sa otvorí približne **{date}** (o {n} týždne)."
  - planned cycle without date: the `plan_note` text.
  - nothing planned: "O ďalšom kole dáme vedieť."
  The modal is dismissible; after dismissal a slim banner with the same text stays at the top. The
  friend can still browse the catalogue (drives anticipation) and open the menu (history, balance).
- **R1.4 Locked state (friend has ordered, waiting).** Landing shows the friend's own order summary
  card + the *cycle timeline* (F3) with the current stage highlighted, then the grid read-only.
  If the friend did *not* order in a locked cycle: the state modal says the round is closed and when
  the next is expected.
- **R1.5 History moves.** Past rounds ("Moje objednávky") become a menu item (F2) listing archived
  cycles with the friend's order per cycle. Same data as the current archive fold.
- **R1.6 Vocabulary.** The UI never says "cyklus" to a friend. Use "kolo" only in history
  ("Kolo september 2026") and "aktuálna ponuka" for the shop.
- **R1.7 Deep links keep working.** `/friend/cycles/:id` (or whatever FriendOrder's route is) stays
  valid — share-row links, e-mails and the admin's links to a cycle must not break.

### Data / backend
- `order_cycles.opens_at DATE` (nullable) — set on planned cycles; drives R1.3's "za n týždňov".
  `expected_date` stays what it is (delivery expectation).
- No other schema change; the friend cycles endpoint already returns everything else.

### Impact / risk
- Large e2e surface: `portal-cycles`, `portal-share-row`, `portal-fidelity`, `portal-appbar`,
  `guest-link` (clicks cycle cards). This needs its own spec module + sanctioned-edit list, like the
  Neobrutal restyle had. Budget it as a module, not a task.
- The share row (colleague link) currently lives on the cycle card → must move onto the shop header
  or into the menu ("Pozvať kolegov k tejto objednávke").

---

## 2. F2 — Declutter: one hamburger menu

### Requirements
- **R2.1 Appbar** = brand + (state chip, e.g. "Otvorené do …" / "Zatvorené") + **menu button**.
  Nothing else. Balance, profile, invite, subscriptions, logout all move into the menu.
- **R2.2 Menu items** (order): Aktuálna ponuka · Moje objednávky · Zostatok a platby ·
  Pozvať priateľa · Zdieľať objednávku s kolegami (only when a cycle is open) · Ako to funguje (F3) ·
  Profil · Odhlásiť sa.
- **R2.3 Money stays visible when it matters.** A non-zero balance (debt) renders a slim banner on
  the landing with "Zaplatiť" (opens PaymentModal). Zero/positive balance is *not* shown on the
  landing — only under "Zostatok a platby". (Reverses the "always show balance card" default from the
  restyle backlog; that decision was taken before this feedback.)
- **R2.4 Profile modal** absorbs: name, phone, e-mail, Packeta address, password, Google link,
  **WhatsApp opt-in (F5)**, **preferred pickup point (F3.5)**.
- **R2.5 Subscriptions (cycle-type filter) retired** (bakery is gone, so the filter has nothing to
  filter). Keep the column and endpoint; stop rendering the modal and the gear.
- **R2.6 Mobile first.** Menu is a full-height NeoModal/drawer (Teleport to body per the `.app`
  z-index rule); desktop shows the same drawer, no separate top nav.

### Open question
- Q2.a Keep the "Pozvať" chip visible in the appbar as the one growth CTA? *Default: no — it goes in
  the menu; growth comes from the share row and the guest CTA, which stay in context.*
- **PO 2026-09-04:** R2.3 (zero balance hidden on landing) and the whole appbar/menu layout are to be
  decided on the Claude Design canvas first, then written back here.

---

## 3. F3 — "Ako to funguje": timeline, first-login explainer, delivery rules

### 3.1 Cycle stage model (backend, prerequisite for F1, F3, F5)
Today `locked` covers everything from "orders closed" to "bag in your hand". Add
`order_cycles.stage` (nullable, only meaningful while `status='locked'`):

| # | stage | Friend-facing label (SK) | Set by |
|---|---|---|---|
| 1 | *(status planned)* | Pripravujeme ďalšie kolo · otvorí sa {opens_at} | admin creates planned cycle |
| 2 | *(status open)* | Objednávky otvorené · do {closes_at?} | admin opens |
| 3 | `ordered` | Objednávky uzavreté, káva objednaná v pražiarni | admin locks (default stage) |
| 4 | `arrived` | Káva dorazila, balíme | admin button |
| 5 | `ready` | Zabalené, rozvážame / odovzdané na odberné miesto | admin button; per-order `packed`/`delivered` refine it |
| 6 | *(status completed)* | Kolo ukončené | admin completes |

Optional `closes_at` on open cycles ("Objednávky do piatku") — feeds F5's "closing soon" message.
One `PATCH /cycles/:id` extension, one admin control on `CycleDetail.vue`.

### 3.2 Timeline component (`CycleTimeline.vue`, one home)
Six steps, horizontal on desktop / vertical on mobile, current step highlighted, past steps ticked.
Used in: F1 landing (locked state), the explainer modal (static, all steps, with one sentence each),
`GuestOrderStatus.vue` (guest sees where their coffee is — replaces the bare "submitted" text), and
the admin cycle header (read-only).

### 3.3 First-login explainer
- Shown once per friend after first successful login (`friends.explainer_seen_at`), dismiss = "Rozumiem".
  Reachable any time from the menu. Guests see a compact 3-step version at the top of `/g/:token`
  ("Objednáte → my nakúpime a zabalíme → {host} vám to odovzdá / Packeta doručí").
- Content = the six steps + the **delivery section** (3.4) + "Ako platím" (payment reference / QR /
  links, F6) + "Kto som pre vás" (one personal paragraph from the PO — the human touch).
- Copy is impersonal vy-form (CLAUDE.md). Illustrations: inline SVG, self-hosted (CSP).

### 3.4 Delivery rules (content + policy)
- **Content:** pickup points with `instructions`, `hours`, `map_url` (new nullable columns on
  `pickup_locations`), rendered in the explainer and in `PickupLocationPicker.vue`.
- **Friend-to-friend hand-off** is already the guest model; the explainer says so explicitly:
  "Ak nie ste z Bratislavy, objednajte cez priateľa, ktorý si tovar prevezme, alebo si nechajte
  poslať Packetu."
- **Policy R3.4.1 — DROPPED (PO 2026-09-04: everyone keeps free text).** No flag, no change to the
  picker. The explainer merely *recommends* the listed points and Packeta.
- **Policy R3.4.2:** the invitation approval screen shows the invitee's chosen pickup point; a
  planned pickup point becomes part of registration (`friends.default_pickup_location_id`), so the
  first order pre-selects it and F5 can target "everyone at point X".

### Open questions
- Q3.a Is a 6-step timeline too much for a guest? *Default: guests get 3 steps.*
- Q3.b Do you want a public marketing "Ako to funguje" page on podpultovka.biz (no login)? It helps
  friends explain the thing when they share. *Default: yes, same component, static route, joins the
  zero-external-requests sweep.*

---

## 4. F4 — Packeta delivery for guests

### Why it matters
It turns every friend's share link into a distribution channel for people outside Bratislava, and it
removes the "my friend isn't ordering this time" dead end. Rewards for the host still accrue.

### Requirements
- **R4.1 Availability:** only when the cycle has `parcel_enabled = 1`; the guest checkout offers
  "Prevezmem od {host}" (default) or "Poslať Packetou (+{parcel_fee} €)".
- **R4.2 Data:** `guest_orders.delivery_fee REAL DEFAULT 0`, `guest_orders.packeta_address TEXT`
  (CREATE **and** ALTER). `total` stays product-only; the amount to pay = `total + delivery_fee`,
  mirrored in the QR, the payment links and the status page. `guestPaymentReference()` unchanged.
- **R4.3 Required contact:** phone already mandatory; **e-mail becomes mandatory when Packeta is
  chosen** (Packeta notifies by e-mail/SMS; also our fallback channel).
- **R4.4 Point selection:** v1 = free text like friends today (name of the Z-BOX/branch + town),
  bounded (160 chars). The official Packeta widget is an external script → CSP exception → separate
  decision (Q4.b).
- **R4.5 Edits:** switching pickup ↔ Packeta follows the friend rules (items editable while unpaid;
  paid sub-order frozen; cancel → refund queue). Fee is re-read from the cycle at each switch.
- **R4.6 Host view / admin / distribution:** red "Packeta" badge on the sub-order, the address shown
  to the admin; Distribution puts guest Packeta orders in the existing Packeta group with the
  guest's phone. Host is told "tento kolega dostane balík Packetou, nemusíte nič odovzdávať".
- **R4.7 Money boundary:** guests have no ledger — nothing here writes `transactions`. Guest paid
  toggle unchanged. Cancelling a Packeta sub-order zeroes `delivery_fee` too.
- **R4.8 Pickup PATCH by admin** (`helpers/pickup.js`) already zeroes `delivery_fee` when switching
  Packeta → pickup on an `orders` row; extend the same helper to `guest_orders`.

### Open questions
- Q4.a Same fee for guests as for friends? *Default: yes, cycle fee.*
- Q4.b Packeta widget (accurate point IDs, needed if you ever automate label/ticket creation via
  the Packeta API) vs. free text? *Default: free text now; widget only with a real Packeta API
  integration, as its own security-reviewed task.*
- Q4.c Should a guest be able to order via a friend who did **not** order in that cycle? Today the
  share link exists per cycle regardless of the host's order, so *yes*, nothing to change — confirm.

---

## 5. F5 — WhatsApp notifications

### ~~Assessment of the two libraries~~ — SUPERSEDED (PO 2026-09-06/19): **whatsapp-web.js only**; Baileys and the official Cloud API are OUT. Kept for history; see §12 and §16.
- **whatsapp-web.js** drives a headless Chromium. Your server is a 4 GB / 2-core box on which
  Chromium already SIGSEGVs in the e2e runs. Not viable next to the API process.
- **Baileys** is a pure WebSocket re-implementation of the WA Web protocol; lightweight, but it
  breaks whenever Meta changes the protocol, and *both* libraries violate WhatsApp's ToS. Numbers
  used for automated/bulk sending get banned, new numbers fastest. A ban of the **bot** number is an
  annoyance; a ban of **your personal** number is a disaster. So: automation only ever from a
  dedicated bot number, and never for the personal broadcast.
- **Official WhatsApp Business Cloud API** (Meta): legitimate, template-based, ≈ €0.03–0.08 per
  utility message in EU, requires a Meta Business verification and template approval; free-form
  replies only inside a 24 h service window. Right tool if volumes grow; too much ceremony for
  ~50–100 people today. Keep as the upgrade path — design the outbox so the sender is pluggable.

### Recommended shape: two phases
**Phase A — assisted personal messaging (no automation, zero ban risk, ships fast)**
- **R5.1 Broadcast composer (admin):** pick a cycle + a *target segment* → the app renders the
  recipient list with a personalised message per person and a `wa.me/<E.164>?text=<urlencoded>`
  click-to-chat link. You tap through them from your phone; each tap opens the chat pre-filled
  from **your** account. A "sent" checkbox per row persists (`notifications` table, see below) so
  you can stop and resume.
- **R5.2 Segments (SQL, one home `helpers/segments.js`):**
  - not ordered yet in open cycle X (active friends, cycle type matches their last orders / tabs);
  - ordered in X (for "closed / at roastery / arrived / packing / ready" updates);
  - packed + pickup point = P + not delivered (the "your bag is at P" message) — friends only;
    guests are reached through their host, unless the guest chose Packeta (R4) → include them;
  - Packeta orders (tracking sent);
  - everyone active (newsletter / new features).
- **R5.3 Templates:** Slovak, editable in admin settings, with placeholders `{meno} {kolo} {miesto}
  {suma} {odkaz}`. Seed the six stage messages from §3.1 + "closing soon" + "at pickup point".
- **R5.4 Phone normalisation:** store `friends.phone` / `guest_phone` as entered **and** derive an
  E.164 copy (`phone_e164`) at write time (+421 default country). Rows that fail to normalise are
  listed in the composer as "bez platného čísla".
- **R5.5 Consent:** `friends.whatsapp_opt_in` (profile toggle, default on for existing friends as
  they already receive your WhatsApp messages, off for new registrations until they tick it);
  the composer excludes opted-out people from *operational* segments too. GDPR: the privacy note
  gains one sentence.

**Phase B — bot number for operational messages (experiment, after Phase A ran ≥ 2 cycles)**
- **R5.6 Separate PM2 process** (`gorifi-wa`) running ~~Baileys~~ **whatsapp-web.js** (PO 2026-09-19) with a dedicated SIM/eSIM number
  ("Podpultovka"), persisting its auth state on disk, talking to the backend only through the
  `notifications` outbox table (status `queued → sent → failed`, `channel ∈ whatsapp|email`).
  Backend stays `instances:1`, synchronous, and never imports the WhatsApp library. A WA crash cannot take the
  API down.
- **R5.7 Human-in-the-loop send:** the admin *queues* a segment; the bot sends with pacing (random
  3–10 s gaps, ≤ 30/hour initially) and stops on the first auth error. Nothing is sent on a timer
  without an explicit admin action in v1. Stage changes (§3.1) *propose* the message; they don't fire it.
- **R5.8 Fallback:** if the bot is down or a recipient has no valid number, the row falls back to
  e-mail via the existing mailer (channel-agnostic outbox).
- **R5.9 Inbound:** replies to the bot are *not* processed in v1 (the bot's WA profile says "Na
  správy odpovedá Karol na čísle …").

### Open questions
- Q5.a Do you have / will you get a second number for the bot? *Without one, Phase B is off the table.*
- Q5.b Acceptable that Phase B may break after a WA protocol change and need a library bump?
- Q5.c Which of the six stage messages do you actually want to send *every* cycle? Six touches per
  round is a lot; *default: closing soon (targeted), arrived, ready/at pickup point — three.*

---

## 6. F6 — Payment links (Revolut + PayMe.sk)

### Requirements
- **R6.1 Revolut:** replace the profile link with an amount-prefilled link:
  `https://revolut.me/<username>?amount=<minor units>&currency=EUR` (verify the current format on
  a phone before pinning it in a spec; Revolut has changed it before). Button label "Zaplatiť cez
  Revolut" showing the amount.
- **R6.2 PayMe.sk** (Slovak Banking Association standard, opens the user's banking app on mobile):
  `https://payme.sk/?V=1&IBAN=<iban>&AM=<12.34>&CC=EUR&DT=<YYYYMMDD>&PI=/VS<vs>/SS/KS&MSG=<ref>&CN=<creditor>`.
  Needs a new setting `payment_creditor_name`. Show the button only under `pointer: coarse` (mobile);
  desktop keeps the QR as the primary path.
- **R6.3 Variable symbol:** introduce a numeric VS so bank matching is automatic: friend orders
  `VS = order.id`, guest orders `VS = 9<guest_order.id>` (or a dedicated `payment_vs` column), balance
  payments `VS = friend.id` prefixed. Put the same VS into the bysquare payload (`variableSymbol`)
  and keep the human text in `paymentNote`. Server-owned, like the reference today.
- **R6.4 One component.** All four surfaces already use `PaymentModal.vue`; change it once. The
  QR contract pinned by `guest-payment-modal.spec.js` (pixel-compared) means the payload change is a
  sanctioned spec edit — list it.
- **R6.5 Tracking (nice-to-have):** "Zaplatil(a) som" self-report button that flags the order for
  the admin's paid toggle (no ledger write). *Default: defer.*

### Open questions
- Q6.a **In plain words:** the app already stores a Revolut username (admin Settings →
  `payment_revolut_username`) and builds `revolut.me/<username>`. I only need to know that this is
  the handle you see under "Revolut.me" in your Revolut app, so the amount-prefilled variant can be
  tried on a phone. Nothing else is needed from you; the first task will test it.
- Q6.b **In plain words:** a PayMe.sk link carries the *recipient's name* so the payer's bank app can
  show "Platba pre …". That is simply the name printed on your bank account (the one whose IBAN is in
  Settings). It becomes a new field next to the IBAN in admin Settings; you fill it in there.

---

## 7. ~~F7 — Bag labels (8 per A4)~~ — OUT OF SCOPE (PO 2026-09-06, confirmed 2026-09-19): labels are already implemented separately. Section kept for reference only; nothing below is planned.

### Requirements
- **Printer (PO 2026-09-04): Brother HL-2250D** — A4 mono laser, printed from a laptop. Consequences:
  labels are black-and-white only (no colour badges; use weight, borders and a ✓/■ stamp), buy
  laser-rated 8-up sheets (e.g. Herma 4426 / Avery 3427 / any "105 × 74 mm, 8 na hárok" — laser
  sheets, not inkjet, or the toner smears), feed via the manual slot for thick sheets.
- **R7.1 Sheet geometry:** a print view `/admin/cycles/:id/labels` rendering an 8-up A4 grid
  (2 × 4). Exact label size is a **setting** (default 105 × 74 mm, margins 0 — the common
  "8 na hárok" format; alternative 99.1 × 67.7 mm Avery L7165 has 4.65 mm margins). `@page { size: A4;
  margin: 0 }`, fixed mm units, no headers/footers (documented print dialog settings), and a
  **calibration page** with corner marks to check the printer's scaling once.
- **R7.2 Label content:** name (friend `name` = Packeta delivery name, or `guest_name` +
  "cez {host}"), order id (`#123` / `G45`), cycle name, **delivery line** (pickup point name /
  "Packeta: {address}" + phone / "odovzdá {host}"), items (`product · variant · qty`, one line each,
  small mono), total to pay + "ZAPLATENÉ" stamp when paid. No prices per line.
- **R7.3 Overflow:** an order with more lines than a label fits continues onto the next label with
  "1/2", "2/2"; the grid never shrinks text below a readable minimum.
- **R7.4 Sheet filling:** labels ordered by distribution group (pickup point → Packeta → hand-over
  hosts), so one location's bags print contiguously; a "start at position n" control reuses a
  partially used sheet; the last page is padded with blanks.
- **R7.5 Filters:** whole cycle · one pickup group · only not-yet-printed. Printing stamps
  `orders.label_printed_at` / `guest_orders.label_printed_at` (admin confirms after the print dialog).
- **R7.6 Data source:** the same query as `Distribution.vue` (guest UNION per CLAUDE.md
  aggregation rules); do not reimplement grouping.
- **R7.7 No `order_token` in a QR** on the label (a bag left at a pickup point would expose the
  guest's status page). A payment-QR (bysquare) on the label *is* useful for unpaid orders and is
  safe — optional toggle.

### Open questions
- Q7.a Exact label product (brand/code) and printer? Decides the default geometry.
- Q7.b Print from the phone or a laptop? (Phone printing changes the calibration advice.)

---

## 8. Proposed order and sizing — ~~superseded~~ by §12 (revision 2026-09-06)

Dependencies: F1 needs the stage model + timeline (F3.1/3.2) and the menu (F2) to have a home for what
it removes; F5 messages are named after F3.1 stages; F4 benefits from F6 (guests can pay in one tap);
F7 is independent.

| # | Slice | Size | Value | Risk | Why here |
|---|---|---|---|---|---|
| 1 | **F6 payment links + VS** | S | high (every payer, every cycle) | low | Quick win, one component, immediate cash-flow effect |
| ~~2~~ | ~~**F7 labels**~~ — out of scope, done elsewhere | | | | |
| 3 | **F3.1 + F3.2 stage model & timeline** (+ `opens_at`, `closes_at`, pickup-point instructions) | M | medium alone, enabler | low | Backend small; unlocks F1's closed-state copy, guest status page, and F5 templates |
| 4 | **F1 + F2 + F3.3 portal information architecture** (landing = shop, menu, explainer, history, delivery rules policy) | L (module) | very high (the actual complaint) | medium (e2e surface) | Do as one spec module with its own sanctioned-edit list, like the restyle |
| 5 | **F4 guest Packeta** | M | high (growth outside BA) | medium (money columns) | After F6 so guests pay in one tap; after F1 so the guest explainer copy exists |
| 6 | **F5 Phase A composer + segments + phone normalisation + opt-in** | M | high, zero ToS risk | low | Uses stages from step 3; you keep sending from your own account |
| 7 | **F5 Phase B bot** | L | medium | **high** (ban, protocol churn, ops) | Only after Phase A has run two cycles and Q5.a/b are yes |

Each slice = one spec module (`docs/specification/15…`) + backlog rows via `/plan-backlog`, then
`/next-task`. Steps 1–3 can run as ordinary tasks; step 4 is a module of ~8–12 rows.

---

## 9. Recommendations that differ from the original list

1. **Do not automate messages from your personal number.** Phase A gives you the personal touch
   *and* targeting; the bot is for operational, low-emotion messages and can wait.
2. ~~**Do not pick whatsapp-web.js.** Chromium on that box is the reason, before ToS. If Phase B
   happens, it is Baileys in its own process, or the official Cloud API when volume justifies it.~~ **REVERSED (PO 2026-09-06): whatsapp-web.js, server resources will be added — see §12.**
3. **Retire the subscription (cycle-type) filter** rather than moving it into the menu; tabs cover it.
4. **Send fewer status messages than the six listed.** Three touches per round (closing soon →
   targeted; arrived; ready) is the default; the others are visible in-app on the timeline.
5. **Hide a zero balance from the landing; never hide debt.**
6. **Guest Packeta with free-text point first**; the Packeta widget only with a real API integration.
7. **Bundle F1/F2/F3 as one module.** Doing "landing = shop" without the menu leaves nowhere to put
   history and balance; doing the menu without the landing change keeps the confusing first screen.

---

## 10. Consolidated open questions for the PO (defaults in italics)

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | ~~How often are coffee and bakery cycles open at the same time?~~ | **Bakery retiring — one open cycle max (PO 2026-09-04)** |
| Q2 | Will every planned cycle get an `opens_at` date? | *Optional; text fallback* |
| Q2.a | Keep "Pozvať" in the appbar? | *No, menu only* |
| Q3.a/b | Guest timeline length; public "Ako to funguje" page? | *3 steps; yes* |
| Q4.a/b/c | Guest fee = friend fee; widget vs text; host-not-ordering OK? | *Yes; text; yes* |
| Q5.a/b/c | Second number for bot? accept breakage? which messages? | **Q5.a: YES (PO 2026-09-04)** → Phase B is in scope; b/c *–; three* |
| Q6.a/b | Revolut handle/account type; creditor name | *needed before F6 starts* |
| Q7.a/b | Label product & printer; phone or laptop printing | **Brother HL-2250D, laptop (PO 2026-09-04)**; sheets: 105×74 mm laser 8-up |
| R3.4.1 | ~~Who may use free-text pickup?~~ | **Everyone (PO 2026-09-04) — policy dropped** |
| R2.3 | Zero balance hidden on landing? | **Decide on the design canvas (PO 2026-09-04)** |


---

# Revision 2026-09-06 — distribution pipeline, WhatsApp re-assessment, awareness content, new order

## 11. F8 — Distribution planning & hand-over pipeline (new)

### Why
After lock the admin needs to *plan* the week: how many bags go to Packeta, how many to each pickup
point, how many are handed over in person — so the Packeta drop and the pickup-point visits fit the
commute, and bags can be prepared in that order. Today `Distribution.vue` is a flat per-friend list with
per-item "packed" checkboxes; the delivery method is only a badge.

### Vocabulary (one home: `helpers/delivery.js`)
Every **party** (friend order or guest sub-order) resolves to a **delivery type** and a **target**:

| type | rule | target |
|---|---|---|
| `packeta` | `packeta_address` set (friend today; guest after F4) | the Packeta point address + phone |
| `pickup` | `pickup_location_id` set | the pickup location |
| `in_person` | neither (with or without `pickup_location_note`) | the admin hands it over personally |
| `via_host` | guest sub-order without its own Packeta | **the host** — the guest's bag travels *inside the host's bag*, so it inherits the host's type/target for planning |

The same helper feeds the existing labels feature (sheet order, if it adopts it), F5 segments (who to notify) and F4 (guest Packeta).
`helpers/pickup.js` stays the writer of the columns; `delivery.js` is read-only derivation.

### Bag stages (per party, ledger-neutral except the existing one)
1. **Na zabalenie** — default after lock.
2. **Zabalené** — existing `orders.packed` / all guest items packed. *Unchanged*: it is the moment the
   friend's charge is posted (`helpers/packing.js`). Meaning for the admin: "I physically have every
   product of this bag, it is closed and labelled".
3. **Odovzdané** — NEW admin flag `handed_over_at` on `orders` **and** `guest_orders` (CREATE + ALTER).
   Meaning: the bag left the admin's hands — dropped at Packeta, left at the pickup point, or handed to
   the host / the friend. **Writes no `transactions` row.** Cannot be set before stage 2 (409).
   Reversible (un-hand-over clears the timestamp) for the mis-click case.
4. *(existing, host-only, guests only)* `guest_orders.delivered` — the host's own "I gave it to my
   colleague" tick. Untouched; it is stage 4 for guests only.

Guest sub-orders **inherit stage 3 from their host's bag** when the host is handed over (one bulk write
inside one transaction) — the guest's bag is inside the host's bag, so it cannot be handed over
separately. A guest who chose Packeta (F4) is its own bag and its own party.

### Admin: the distribution board (`Distribution.vue`, redesigned)
- **Header = the plan.** One line per group with counts: "Packeta 3 · Kaviareň Ruža 5 · Coworking Nivy 2
  · Osobne 4" and the stage progress per group (n/N zabalené, n/N odovzdané). Visible right after lock —
  this is what the admin plans the week from.
- **Group by** switch: *Doručenie* (default: Packeta → each pickup point → Osobne; hosts' guest bags
  nest under the host) · *Stav* (Na zabalenie / Zabalené / Odovzdané) · *Priateľ* (today's flat list).
- **Per group actions:** "Vytlačiť štítky" (F7, that group only) · "Odovzdať všetko zabalené" (bulk stage 3,
  confirm dialog with the count) · "Poslať správu" (F5 segment = this group, template "at pickup point"
  / "handed to Packeta" / "handed to your friend").
- **Per bag:** existing item checkboxes + Zabaliť; new **Odovzdané** checkbox (disabled until packed);
  Packeta bags show the address + phone (the label needs them too); a guest bag shows "cez {host}".
- **Print sheet** keeps working; the fold/pickers stay `print:hidden` per the existing rules.
- **Admin cycle header** shows the same plan line and, when every bag is at stage 3, offers
  "Ukončiť kolo" (cycle → completed) — the pipeline feeds the F3.1 stage automatically:
  first stage-3 bag → cycle stage `ready`.

### API (all behind `requireAdmin`, all into `ADMIN_ENDPOINTS`)
- `GET /api/cycles/:id/distribution` → parties with `{type, target, packed, handed_over_at, guests[]}` (one
  query set, guests merged in JS, never a second LEFT JOIN).
- `PATCH /api/orders/:id/handed-over` and `PATCH /api/guest-orders/:id/handed-over` (admin; body
  `{handed_over: true|false}`; 409 `not_packed`).
- `POST /api/cycles/:id/distribution/hand-over` `{order_ids:[], guest_order_ids:[]}` bulk, one transaction,
  each row re-checked for `packed` inside it (`instances:1`, synchronous).
- Hand-over also **enqueues** notifications (F5 outbox) but never sends synchronously.

### Prototype first (PO request)
The board's layout against today's switches, pickup pickers and Packeta badges is not obvious. Next
Claude Design step: an **admin distribution board** artboard set (desktop 1180, the admin shadcn skin, not
the neobrutal one): plan header · group-by switch · a Packeta group · a pickup-point group · an in-person
group with a host + nested guests · stage filters · bulk hand-over confirm · the label-print entry point.

### Notifications wired to the pipeline (F5)
| trigger | recipients | template |
|---|---|---|
| bag → Odovzdané, type `pickup` | the friend | "Vaša káva je v {miesto} ({hodiny}). Vyzdvihnite si ju do {dní} dní." |
| bag → Odovzdané, type `packeta` | the friend / Packeta-guest | "Balík sme odovzdali Packete, sledovanie: {tracking}." |
| host bag → Odovzdané | each guest under that host | "Vašu objednávku sme odovzdali {host}. Dohodnite si prevzatie s ním/ňou." (guest reached by their own phone) |
| bag → Odovzdané, type `in_person` | the friend | "Vaša káva je zabalená, dohodneme odovzdanie." |
| every bag of the cycle → Odovzdané | admin only | in-app hint "Ukončiť kolo" |

The stage-3 moment is the natural, low-noise moment to write — it replaces the "ready" broadcast of
§3.1 with targeted messages. Rows go to the outbox as `queued`; the admin presses send (Phase A: opens
click-to-chat links one by one; Phase B: the bot sends).

## 12. F5 re-assessed — memory is not a constraint

With RAM/CPU available on request, the choice is on reliability and behaviour, not footprint:

| | whatsapp-web.js | Baileys |
|---|---|---|
| How | drives the real WhatsApp Web client in headless Chromium (Puppeteer) | re-implements the WA multi-device protocol over WebSocket |
| Breakage pattern | breaks when WA Web changes its internal module names; fixes come as library patches; the *protocol* work is done by Meta's own client | breaks when the protocol changes; the community re-implements it; more frequent but usually fast |
| Behaviour as seen by WA | indistinguishable from a person using WhatsApp Web on a laptop — the safest unofficial profile | a custom client; historically the more flagged profile for bulk-ish sending |
| Media, groups, receipts | complete (it is the real client) | complete, slightly rawer API |
| Footprint | 300–500 MB RSS idle, 700–900 MB peaks; one Chromium | ~80–150 MB |
| Maintenance | active (pedroslopez), large user base | active (WhiskeySockets), large user base |

**Decision: whatsapp-web.js**, in its own PM2 process (`gorifi-wa`), LocalAuth session on disk, QR pairing
rendered in the admin (Nastavenia → WhatsApp), auto-reconnect with backoff, health endpoint the admin
page polls; the API process never imports it and talks to it only through the outbox table. The
~~official Cloud API remains the exit ramp~~ — PO 2026-09-19: no Cloud API; the outbox sender stays a single whatsapp-web.js implementation behind one interface.

**Server requirements (LXC running PM2):**

| resource | now | needed | why |
|---|---|---|---|
| RAM | 4 GB | **8 GB** | +1 GB for Chromium (idle+peak) with headroom; keeps the e2e Chromium runs (which SIGSEGV today) stable too |
| vCPU | 2 | **4** | Chromium start-up and message bursts must not steal from the API |
| disk | – | **+2 GB** | Chromium (~400 MB), session store, message log |
| swap | – | 1–2 GB | protects the API on Chromium peaks |
| PM2 | – | `max_memory_restart: '1200M'` on `gorifi-wa`, `--no-sandbox --disable-dev-shm-usage` Puppeteer args, `/dev/shm` ≥ 256 MB in the LXC |

Dedicated number confirmed (2026-09-04) → Phase B is in scope. Phase A (click-to-chat composer) is still
built first: it is the fallback when the bot is down, and it is how the *personal* number keeps being used.
Pacing, opt-in, E.164 normalisation and templates as in §5 (R5.2–R5.5, R5.7).

## 13. F3 awareness content — what a newcomer must be told

"Ako to funguje" (F3.3) gains a **"Kto sme a odkiaľ je káva"** block, also published as the public page:

1. **Origin** — Podpultovka started as one friend ordering for friends; it is invitation-only, run in free
   time, not a shop. One paragraph in the PO's voice (placeholder text until the PO writes it).
2. **Two sources of coffee** — shown as the two roaster badges already on every product card:
   - **Goriffee** — the roastery; the regular offer.
   - **Robo** — a home roaster. He hunts for green coffee with high **SCA** (Specialty Coffee Association)
     cupping scores and roasts it himself in small batches; everything under his badge is hand-roasted at
     home. (PO to polish the text.)
3. **How the round works** — the six phases (§3.2).
4. **How you get it** — pickup points, via a friend, Packeta (§3.4).
5. **How you pay** — after packing, QR / Revolut / PayMe (§6).
6. **Manners** — pick up within a few days, tell your friend when you cannot, ask on WhatsApp.

Placement: first login (once), menu → Ako to funguje, guest link top (3-step compact + the two roasters in
one line), public `/ako-to-funguje` on podpultovka.biz. Product cards keep the roaster badge; tapping it
opens a one-sentence popover from the same content source (one home: `lib/roasters.js`).

## 14. Roadmap v2 — ~~superseded~~ by §17 (PO decisions 2026-09-06)

```
F6 payment links ─┐
                  ├─► (independent, quick wins)
delivery.js ──────┼─► F8 board + hand-over ─► ~~F7 labels per group~~ ─► F5-B bot triggers
                  │            │
                  │            └─► F3.1 cycle stages (auto-fed) ─► F1/F2/F3 portal IA module
F5-A composer ────┘                                                        │
F4 guest Packeta ◄─ delivery.js, F6                                         └─► public "Ako to funguje"
```

| # | Slice | Size | Depends on | Notes |
|---|---|---|---|---|
| 1 | **F6 payment links + VS** | S | – | unchanged |
| 2 | **Admin distribution board — Claude Design prototype** | S | – | PO reviews layout before code |
| 3 | **F8a `helpers/delivery.js` + `handed_over_at` + endpoints** | M | – | backend only; e2e for 409 `not_packed`, ledger-neutrality, guest inheritance |
| 4 | **F8b distribution board UI** (groups, plan header, stage filters, bulk hand-over) | M | 2, 3 | replaces today's flat list; print sheet preserved |
| ~~5~~ | ~~**F7 labels per group**~~ — out of scope (done elsewhere) | | | |
| 6 | **F3.1 cycle stages + timeline** (auto-fed by F8) | S/M | 3 | `opens_at`, `closes_at`, `stage` |
| 7 | **F5-A composer + segments + E.164 + opt-in + outbox table** | M | 3, 6 | hand-over enqueues rows; admin opens click-to-chat links |
| 8 | **Portal IA module (F1+F2+F3.3 incl. §13 content)** | L | 6, PO comments on the v2 prototype | its own spec module + sanctioned-edit list |
| 9 | **F4 guest Packeta** | M | 1, 3 | guest becomes its own bag/party |
| 10 | **Server upgrade (8 GB / 4 vCPU) + F5-B whatsapp-web.js process** | L | 7, upgrade, number | outbox sender #2; pickup/Packeta/host triggers go live |
| 11 | **Public "Ako to funguje" page** | S | 8 | same component, static route, zero-external-requests sweep |

Slices 1–3 can start immediately and in parallel with the PO's review of the portal prototype.
Each slice = one spec module or one row group in `PROGRESS.md`, then `/next-task`.

## 15. Open questions raised by this revision (defaults in italics)

| # | Question | Default |
|---|---|---|
| Q8.a | Should the admin be able to mark **Odovzdané** on an unpacked bag (e.g. handed over a partial bag)? | *No — 409; unpack first if the bag changes* |
| Q8.b | Pickup-point "pick up within N days" in the message — value? | *5 dní, per-location setting* |
| Q8.c | Auto-complete the cycle when every bag is handed over? | *No, offer the button; the PO completes* |
| Q5.d | Bot messages sent immediately on hand-over, or batched and released by the PO? | *Batched: queued on hand-over, released with one "Poslať" per group* |
| Q13.a | Robo's text and whether his coffees get a visible "domáce praženie" badge variant | *PO writes text; badge stays "Robo"* |


---

# PO decisions 2026-09-06 (folded in) and roadmap v3

## 16. Decisions

| Ref | Decision | Consequence |
|---|---|---|
| R1.3 / R1.6 | User-facing copy says **„objednávka“** for the next ordering round („Ďalšia objednávka sa otvorí…“), never „kolo“/„cyklus“. | Prototype + spec copy updated; history lists rounds by their cycle *name*. |
| Q2.a | **„Pozvať“ stays in the appbar** — zero-friction growth reminder on the dashboard. | v2 appbar = menu · brand · Pozvať chip · lock icon (closed/locked only). The open state needs no chip (ticker + status line say it). |
| §3.4 | Sentence corrected: **„Nie ste z Bratislavy? Objednajte si a nechajte poslať cez Packetu.“** Guests either pick up from their friend or (after F4) get Packeta. | Explainer „Ako sa ku káve dostanete“: Odberné miesto · Cez priateľa (prevezmete od neho/nej) · Packeta. |
| Q3.a | **3-step guest explainer** — alternative designed in Claude Design (`g-link2`, state „Otvorené · 3 kroky“); PO decides. | — |
| Q3.b | **No public page.** Podpultovka stays private: friend tells someone → sends the link on request → guest reads how it works on the link → decides. | Slice „public Ako to funguje“ dropped; the guest link carries the explainer. |
| Q4.a/b/c | Guest Packeta: same fee as friends; free-text point (no Packeta API on the roadmap); guests may order even when the host orders nothing. | F4 unchanged. |
| F5 | Phase A is not imaginable without screens → **screens first** (`a-wa`: „Cez bota“ vs „Ručne (wa.me)“ tabs, PO decides). **WhatsApp is the last feature** of this roadmap, launched after the next ordering round proves the in-app visibility. | F5 moves to the end; F8 still records hand-over so the trigger data exists when WA arrives. |
| Q5.a/b/c/d | New number: yes. Server gets whatever whatsapp-web.js needs (no official API). **Three notifications** to start. Messages **released with one „Poslať“ per group**. | §12 stands. |
| Q6.a/b | Revolut handle **@karolskolar**; PayMe creditor name **„Karol Skolar“**. | F6 has everything it needs. |
| F7 | **Deferred entirely** — labels are already in the works elsewhere and land before this roadmap. | Removed from the plan; the board keeps a „Štítky“ entry point for it. |
| Q8.b | Pickup message says only that it is delivered and can be picked up — **no „within N days“**. | Template text fixed. |
| Q8.c | **No auto-complete** of the round. | Manual „Ukončiť“ only. |
| Q13.a | Roaster/„Kto sme“ texts: **defaults in the prototype**, PO polishes. | Drafted in the explainer. |

## 17. F9 — Share link before the round opens (new flow)

**Scenario:** the round is closed and done. A friend tells a colleague about Podpultovka; the colleague wants
in as a guest. The friend must be able to share a link *now*; the guest must see that ordering is closed,
when the next one is expected, how it works — and leave a contact so they hear when it opens.

- **R9.1 Host link is not tied to an open round.** Today `guest_order_links` are per cycle. Add a
  host-level *standing* link (`friends.guest_link_token`, generated once, regenerable) that resolves to
  „the current round“: open → today's guest ordering; planned/closed → the pre-open page. Per-cycle links
  keep working (they redirect to the same page when their cycle is not open).
- **R9.2 Pre-open guest page** (`/g/:token` when nothing is open): host name, „Objednávky sú zatvorené“,
  „Ďalšia objednávka približne {date}“, the 3-step explainer + roasters, and a **„Dajte mi vedieť“** form:
  name (120) + phone (32) + WhatsApp opt-in checkbox → `guest_waitlist` (link/host id, cycle id nullable,
  phone_e164, created_at, notified_at). Public write → same bounds/rate limits as `routes/guest.js`
  (`guestWrite` bucket), uniform responses, no oracle. Duplicate phone per host → 200 (idempotent).
- **R9.3 When the round opens**, the waitlist is an F5 segment („Čakajúci hostia“) with the template
  „{host} vám otvoril objednávku kávy: {link}“. Until WA lands, the admin sees the list under the cycle and
  the host sees „N ľudí čaká na váš odkaz“ on the share row.
- **R9.4 Host view:** share dialog shows the standing link + „kto čaká“ count; the host can copy the link
  any time from the appbar „Pozvať“/„Zdieľať“.
- Waitlist rows are contact data of non-members: shown to the host only as a count, to the admin in full;
  deletable; purged when the guest orders or 2 rounds pass.

## 18. Roadmap v3 (supersedes §14)

| # | Slice | Size | Depends on | Status |
|---|---|---|---|---|
| 1 | **Prototypes in Claude Design**: admin distribution board · WhatsApp composer/settings · guest pre-open + 3-step · portal copy fixes | S | – | **this turn** |
| 2 | **F6 payment links + VS** (@karolskolar, „Karol Skolar“) | S | – | ready to spec |
| 3 | **F8a `helpers/delivery.js` + `handed_over_at` + endpoints** | M | – | ready to spec |
| 4 | **F8b distribution board UI** | M | 1, 3 | after PO comments |
| 5 | **F3.1 cycle stages + timeline** (`opens_at`, `closes_at`, `stage`, fed by F8) | S/M | 3 | |
| 6 | **Portal IA module** (F1+F2+F3.3, Pozvať chip, „objednávka“ wording, Kto sme + roasters) | L | 5, PO comments | its own spec module |
| 7 | **F9 standing guest link + pre-open page + waitlist** | M | 5 | guest surface |
| 8 | **F4 guest Packeta** | M | 2, 3 | |
| 9 | **Server upgrade (8 GB / 4 vCPU) → F5 WhatsApp** (outbox, segments, E.164, opt-in, whatsapp-web.js process, 3 templates, per-group release) | L | 3, 5, 7, next round done | **last** |

Removed: F7 labels (in progress elsewhere), public „Ako to funguje“ page (Q3.b).
Slices 2 and 3 start now; 4–8 follow the PO's comments on the prototypes; 9 after the next round.

## 19. Profile modal (PO review 2026-09-18, applied to the prototype)

| Field | Label | Editable | Help text |
|---|---|---|---|
| `friends.username` | **Login** | no (read-only row) | „Prihlasovacie meno. Nemení sa.“ |
| `friends.name` | **Meno a priezvisko *** | yes | „Celé meno. Uvádza sa na zásielke pri doručení Packetou a vidí ho správca aj kolegovia.“ (unchanged from the live app) |
| `friends.phone` | **Mobil *** | yes | „Pre koordináciu objednávky a odovzdanie.“ (new, required — also the WhatsApp target, F5) |
| `friends.email` | E-mail | yes (optional) | „Voliteľné. Packeta naň posiela informácie o zásielke; slúži aj na obnovenie prístupu.“ (PO 2026-09-19: needed for Packeta delivery) |
| `friends.packeta_address` | Adresa Packeta výdajného miesta | yes | unchanged |
| — | Zmeniť heslo (fold) | — | unchanged |

Removed: the „Jedinečné ID“ (`friends.uid`) row — the friend never needs it. E-mail is shown as an optional field (Packeta notifications + recovery); becomes required when Packeta is chosen (R4.3 already says so for guests — same rule for friends). Rule from CLAUDE.md holds: `friends.name` is never called a login.
