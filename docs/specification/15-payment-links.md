# 15 — Payment links (Revolut amount link, PayMe.sk, variable symbol)

> Scope: Make the money a friend or guest owes land in the admin's bank account with as
> few taps and as little manual matching as possible. Three things: (a) the Revolut button
> becomes an **amount-prefilled** link; (b) a **PayMe.sk** deep link (Slovak Banking
> Association standard — opens the payer's banking app with everything filled in) is added,
> **mobile only** (`pointer: coarse`), fed by a new admin setting `payment_creditor_name`;
> (c) a **numeric variable symbol (VS)** is introduced so the bank statement matches an order
> automatically — server-owned with ONE home (`backend/src/helpers/payment.js`, next to the
> `guestPaymentReference()` precedent), placed into the bysquare `variableSymbol`, the PayMe
> `PI`, a copy row in the modal, the guest confirmation mail and the admin receivables
> screens; the human reference text stays byte-identical in `paymentNote`. All friend/guest
> surfaces change through the ONE component `PaymentModal.vue` (plus the friend success
> modal, which shares the same composition helper — UC-PL-004). Backend + settings change,
> **no schema table and no new column** (`settings` is key/value; VS is DERIVED, never
> stored — resolved decision D1).
> Out of scope (handoffs): **guest Packeta fee inside the amount** → module 20 (this module
> only guarantees the component and the server `payment.amount` already carry
> `total + delivery_fee` where a fee exists — friends today, guests from module 20);
> **WhatsApp payment messages / reminders** → module 21 (they will reuse the VS + links from
> `helpers/payment.js`, never recompose them); **R6.5 „Zaplatil(a) som“ self-report** —
> DEFERRED by the roadmap doc's own default (§6 R6.5 *"Default: defer"*); recorded in
> §Deferred, not specified; **any `transactions` write** — paying through a link records
> nothing; the admin's paid toggle / `POST /api/transactions/payment` remain the only ledger
> writers (CLAUDE.md §Money & data).
> Actors: **Friend** — sees the new Revolut/PayMe buttons and the VS on their order and on
> their balance; no new write. **Guest** — same on the confirmation screen, the status page
> and the confirmation mail; no new write; the public payload gains two read-only fields.
> **Admin** — fills in the creditor name in Settings; sees the VS next to every reference on
> the receivables card and the orders tab; still the sole owner of `paid`.
> Sources: `docs/superpowers/specs/2026-09-03-roadmap-requirements.md` §6 (F6, R6.1–R6.5;
> Q6.a/b), §16 rows Q6.a/b (**Revolut handle `@karolskolar`, PayMe creditor name „Karol
> Skolar“** — the NEWEST decision, wins over §6's open questions), §18 row 2 (slice 2,
> "ready to spec", depends on nothing); `00-overview.md` §Scope extension — roadmap October
> 2026 + index row 15; `01-architecture.md` §Roadmap October 2026 additions
> (`settings.payment_creditor_name`), §Payment deep links, §Dependencies ("no new package;
> `bysquare` gains the `variableSymbol` field it already supports"), §Testing & gate
> (pixel-QR approach; payload change is a sanctioned spec edit, listed per module); repo
> code: `frontend/src/components/PaymentModal.vue` (the FROZEN props contract of 06
> §UC-GX-005 — extended here, see D4), `frontend/src/views/FriendOrder.vue` (`paymentTotal`,
> `paymentReference`, `generateSuccessQr`, the inline Revolut `<a>` of the success modal),
> `GuestOrder.vue`, `GuestOrderStatus.vue`, `FriendBalanceCard.vue`,
> `FriendTransactionsModal.vue`, `frontend/src/lib/money.js` (`roundMoney`, `fmtEur`),
> `backend/src/helpers/guest-orders.js` (`guestPaymentReference()`),
> `backend/src/routes/guest.js` (`paymentSettings()`, `statusPayload`, the 201 payload,
> `deliverOrderConfirmation`), `backend/src/routes/guest-orders.js` (unpaid overview),
> `backend/src/routes/orders.js` (friend GET/PUT/submit), `backend/src/routes/friends.js`
> (`GET /:id/balance`), `backend/src/routes/admin.js` (`/settings`, `/payment-settings`,
> `bindValue`), `backend/src/helpers/bind-value.js`; shipped e2e specs
> `guest-payment-modal`, `money-rounding`, `order-modals`, `guest-order-recovery`,
> `api-security`, `self-hosted-fonts`; `e2e/seed.mjs`. The most recent decision wins on
> conflict.
> **Design reference:** no prototype screen exists for PayMe or the VS row. The PayMe button
> reuses the Revolut bar's geometry (`.btn.block`, ink border, one glyph + label) in the
> default ink/paper colours — no bank brand colour; the VS row is a second `NeoCopyRow small`
> under the existing reference row (06 §UC-GX-005 item 3). Admin additions keep the shadcn
> skin (01-architecture §Design system scope rule).

---

## Resolved conflicts / decisions (recency / canonicity)

1. **D1 — VS is derived, not stored.** R6.3 offers "`9<guest_order.id>` *or a dedicated
   `payment_vs` column*". Derivation wins (the orchestrator's stated preference, and the
   one-home rule): a column would be a second source of truth that a cancel, a merge or a
   hand edit could desynchronise from the id the admin is looking at. Collision-free scheme
   in UC-PL-001.
2. **D2 — the human reference text does not change.** `G{id} / {meno} / {cyklus}` (guest,
   `guestPaymentReference()`) and `{meno} / {cyklus}` (friend, `FriendOrder.paymentReference`)
   stay byte-identical in `paymentNote` / the copy row / the mail (R6.3 "keep the human text
   in `paymentNote`"). Every shipped pin on the reference string
   (`guest-order-recovery.spec.js:508,599,2825`, `guest-payment-modal.spec.js:279`) keeps
   passing. Only the friend VS becomes server-owned; the friend reference stays
   client-composed as today (widening that is not in F6).
3. **D3 — the bysquare `beneficiary.name` follows the creditor name.** Today it is the
   literal `'Gorifi'`. With a creditor name configured the QR and the PayMe link would
   otherwise show two different payees in the same banking app ("Gorifi" vs „Karol
   Skolar“). Rule: `beneficiary.name = creditorName || 'Gorifi'` — byte-identical to today
   while the setting is blank, so `money-rounding.spec.js` (which mocks payment settings
   WITHOUT a creditor name) keeps its hard-coded `'Gorifi'` valid.
4. **D4 — 06 §UC-GX-005's "props API is FROZEN" is superseded additively.** Two optional
   props (`variableSymbol`, `creditorName`) are added; every existing prop, the `close`
   emit, the `v-if` mount and the `'-'` amount guard are untouched. The "frozen" sentence in
   06 §UC-GX-005 and in `PaymentModal.vue`'s header comment gets a ~~strike~~ + pointer to
   this module (CLAUDE.md §Documentation discipline: rewrite the superseded claim in EVERY
   copy — the 06 spec, the component header, `FriendOrder.vue`'s comments, the e2e headers).
5. **D5 — "four surfaces via one component" is corrected against the code.**
   `FriendTransactionsModal.vue` does NOT mount `PaymentModal` (it only cites it in a
   comment); no balance surface offers payment today. The fourth surface is therefore NEW:
   a „Zaplatiť“ trigger on `FriendBalanceCard.vue` (UC-PL-007 item 4) — on the card, not
   inside the transactions modal, because `NeoModal` supports one modal at a time (UC-DS-010,
   `NeoModal.vue:369`). And there is a FIFTH composition site that is not the component: the
   friend success modal's own `generateSuccessQr()` + inline Revolut `<a>`
   (`FriendOrder.vue:879-913, 1860-1868`). It is re-pointed at the shared composition
   helper (UC-PL-004) rather than left behind — otherwise the friend's first QR would lack
   the VS the „Zaplatiť“ one carries.
6. **D6 — 01-architecture's "pure URL composition in `PaymentModal.vue`" is read as
   "client-side, no outbound call, no dependency"**, not as "inline in that file": the
   composition lives in `frontend/src/lib/payment-links.js` so the success modal (D5) and the
   component share one implementation. The architecture's actual constraints (no network,
   no new package) hold.

---

## UC-PL-001 Variable symbol — the one server home `helpers/payment.js` (system)

**Goal:** every VS the app ever emits comes from one file, with a scheme that can never
map two different debts onto one number.

**New file `backend/src/helpers/payment.js`**, exporting:

| Export | Rule |
|---|---|
| `friendOrderVariableSymbol(orderId)` | `String(orderId)` — R6.3 "friend orders `VS = order.id`" (plain, no prefix, no padding) |
| `guestOrderVariableSymbol(guestOrderId)` | `'9' + String(guestOrderId).padStart(6, '0')` — e.g. guest order 123 → `9000123` |
| `balanceVariableSymbol(friendId)` | `'8' + String(friendId).padStart(6, '0')` — e.g. friend 45 → `8000045` |
| `paymentSettings()` | reads the three `settings` keys once: `{ iban, revolut_username, creditor_name }` (each `'' ` when absent) — the ONE reader; `routes/guest.js`'s private `paymentSettings()` (guest.js:222-226) and the two hand-written reads in `routes/admin.js` (`/settings` GET, `/payment-settings`) are replaced by it |
| `guestPaymentBlock(order, cycleName)` | `{ amount: order.total, reference: guestPaymentReference(order, cycleName), variable_symbol: guestOrderVariableSymbol(order.id), iban, revolut_username, creditor_name }` — the ONE composer of the guest `payment` block; replaces the two hand-written blocks in `routes/guest.js` (`statusPayload` :441-446 and the 201 :806-811) |

**Business rules:**

- **Numeric, ≤ 10 digits, no leading-zero ambiguity in the first digit.** Pay by Square and
  PayMe both define VS as up to 10 numeric characters. The prefix+padding scheme yields 7
  digits for guest/balance and ≤ 6 for friend orders — no collision as long as friend order
  ids stay below 8,000,000 (a friend order VS can start with `8`/`9` only from id 8,000,000
  on). Stated as an invariant; nothing enforces it beyond the guard below.
- **Fails closed, never ambiguous.** Each derivation requires `Number.isInteger(id) && id > 0
  && id < 1_000_000`; otherwise it returns `''` (an empty VS — the QR still carries the
  human note, PayMe omits `PI`) and logs one line WITHOUT the id's owner data. An empty VS is
  a degraded payment; a wrong VS is money matched to the wrong person.
- **Only these three functions may produce a VS.** No route, view or mail template
  concatenates `'9' +` anything. A grep for `padStart(6` outside `helpers/payment.js` in
  `backend/src` must stay empty (the reviewer's check).
- **`guestPaymentReference()` stays in `helpers/guest-orders.js`** (its consumers and pins
  are unchanged); `helpers/payment.js` imports it for `guestPaymentBlock()`.
- **Module 20 seam:** `guestPaymentBlock().amount` is `order.total` today; module 20 changes
  that ONE line to `total + delivery_fee`. No other file computes a guest amount.
- **Module 21 seam:** WhatsApp/e-mail payment messages read `variable_symbol` and the
  links from this helper + `lib/payment-links.js`'s server-side twin if one is ever needed
  — never a re-implementation. (No server-side link composition is required by THIS
  module; the mail carries the VS as text, not a link — UC-PL-003 item 3.)

**Acceptance criteria (API-level, read back):** a guest sub-order with id N answers
`payment.variable_symbol === '9' + String(N).padStart(6,'0')` on the 201 and on both status
URL forms; a friend order with id M answers `payment.variable_symbol === String(M)`; the
balance payload of friend F answers `'8' + String(F).padStart(6,'0')`; all three are
`/^\d{1,10}$/`; the three sets are pairwise disjoint for ids < 1,000,000 (asserted on the
concrete fixtures and by a direct check that no friend VS of the fixture starts with a
7-digit `8`/`9`).

---

## UC-PL-002 Admin setting `payment_creditor_name` (Admin)

**Goal:** Q6.b — the payer's bank shows „Platba pre …“; that name is the account holder's
(§16: **„Karol Skolar“**), entered once by the admin next to the IBAN.

**Backend (`routes/admin.js`):**

- `GET /api/admin/settings` (`requireAdmin`) adds `paymentCreditorName` (read via
  `paymentSettings()` — UC-PL-001).
- `PUT /api/admin/settings` (`requireAdmin`) accepts `paymentCreditorName` through
  `bindValue()` exactly like the other two payment keys (FUP-T13 idiom: unbindable ⇒
  `undefined` ⇒ the write is skipped and the stored value survives; **never** a 500 for
  `{}`/`true`/`[x]`/`'abc'` shapes). Value is `String.prototype.trim()`med; **> 70
  characters ⇒ 400 `{ error: 'Meno príjemcu môže mať najviac 70 znakov' }`** and NOTHING in
  the request is written (the bound check runs before any `INSERT OR REPLACE` in the
  handler). Written as `INSERT OR REPLACE INTO settings ('payment_creditor_name', ?)`; the
  response echoes it like the others. OPEN: the 70 cap is the PayMe `CN` field limit as the
  author recalls it — verify against the current PayMe specification (payme.sk) during the
  first task; if the published cap differs, the server bound and the mirrored `maxlength`
  follow the spec, together.
- `GET /api/admin/payment-settings` (PUBLIC — already listed as public in
  `api-security.spec.js:131`; stays public, stays OUT of `ADMIN_ENDPOINTS`) adds
  `paymentCreditorName`. The creditor name is by definition public data (every bank transfer
  shows it), so publishing it here is not a disclosure.
- **No new route ⇒ no `ADMIN_ENDPOINTS` addition.** `GET`/`PUT /api/admin/settings` are
  already in the list (api-security.spec.js:12).

**Frontend (`AdminSettings.vue`, „Platobne udaje“ card — shadcn, no `neo/`):** a third
field between „Revolut username“ and the save button:

| Field | Type | Constraint |
|---|---|---|
| `paymentCreditorName` | `Input type="text"` | `maxlength="70"` (mirrors the server bound — CLAUDE.md §Auth & boundaries last rule), placeholder `napr. Karol Skolar` |

Label **„Meno príjemcu“**; help text **„Meno majiteľa účtu (IBAN vyššie). Zobrazí sa
platiteľovi v bankovej appke pri platbe cez PayMe a v QR kóde.“** Saved by the existing
`savePaymentSettings()` (one PUT with all three keys — the shipped shape). Loaded in the
existing settings `onMounted` read.

**Business rules:**

- A blank creditor name is legal and means: no PayMe button anywhere (UC-PL-006 rule 1),
  QR beneficiary stays `'Gorifi'` (D3). The help text stays the one sentence above; the
  PayMe button's absence is the visible consequence, not a second warning. ⚠ The seed
  (`e2e/seed.mjs` 3b) sets a creditor name so the e2e PayMe path is non-vacuous
  (UC-PL-009 item 6).
- The Revolut handle is stored WITHOUT `@` (the placeholder already says `karolskolar`);
  the client composition strips a leading `@` and surrounding whitespace defensively
  (UC-PL-004 rule 2) so the PO's literal answer „@karolskolar“ pasted into the field still
  works.

**Acceptance criteria:** PUT with a 70-char name ⇒ 200 and the GET reads it back; 71 chars
⇒ 400 and the previous value is read back unchanged (refusal tests read the row back);
`{ paymentCreditorName: true }` ⇒ 200 with the stored value untouched; the public
`payment-settings` carries the name; the input has `maxlength="70"`.

---

## UC-PL-003 Server payloads carry the VS (and the creditor name) (system)

**Goal:** every place a payer is handed payment data receives the VS from UC-PL-001 — the
frontend never derives one.

1. **Guest (`routes/guest.js`, public, GSO-T3 boundary unchanged):** both `payment` blocks
   (`statusPayload` — served on `GET /api/guest/o/:orderToken` AND the legacy pair form,
   14 §UC-GR-001/002 — and the submit 201) are produced by `guestPaymentBlock()` and thereby
   gain `variable_symbol` and `creditor_name`. Nothing is removed; `amount`, `reference`,
   `iban`, `revolut_username` are byte-identical. The public listing (`GET /api/guest/:token`)
   still carries NO payment data (06 §UC-GX-004 rule).
2. **Guest confirmation mail (`deliverOrderConfirmation`, 14 §UC-GR-011):** `paymentRows`
   gains **`{ label: 'Variabilný symbol', value: payment.variable_symbol }`** directly AFTER
   the reference row, only when `variable_symbol` is non-empty. Text and html parts both
   (the one-array mechanism does that). ⚠ Still no `revolut.me`/`payme.sk` URL in the mail
   (08 §UC-EM-005 item 3 one-origin pin — `guest-order-recovery.spec.js:2831,2854` assert it;
   they keep passing).
3. **Friend order (`routes/orders.js` — `GET`/`PUT /cycle/:cycleId/friend/:friendId`,
   `POST …/submit`):** each response gains a top-level **`payment: { variable_symbol }`**
   (`friendOrderVariableSymbol(order.id)`), or `payment: null` when `order` is `null` (the
   no-order GET and the PUT's `deleted` branch). Deliberately NOT folded into the `order`
   row (a derived field on a `SELECT *` row is how it ends up looking like a column) and
   deliberately NOT carrying `iban`/`revolut_username`: `FriendOrder.vue` keeps its
   `api.getPaymentSettings()` read — `money-rounding.spec.js:693` makes the friend QR
   hermetic by mocking exactly that endpoint, and moving the settings into the order payload
   would silently turn that mock dead.
4. **Balance (`routes/friends.js` `GET /:id/balance`, `requireFriendOwner`):** gains
   **`payment: { amount, reference, variable_symbol, iban, revolut_username, creditor_name }`**
   where `amount = roundMoney(Math.max(0, -balance))` (a friend in credit or settled gets
   `amount: 0`), `variable_symbol = balanceVariableSymbol(friend.id)`, and `reference` =
   **`${friend.name} / zostatok`** — OPEN: draft, PO sign-off (the roadmap doc defines the
   balance VS but no balance reference text; default recorded here). The balance route is
   friend-authenticated already; publishing the admin's IBAN to a friend is what the friend
   order screen does today.
5. **Admin unpaid overview (`routes/guest-orders.js` `GET /cycle/:cycleId/unpaid`,
   `requireAdmin`):** each `unpaid` and `refunds` row gains `variable_symbol`
   (`guestOrderVariableSymbol(row.id)`) next to the existing `reference` (the hand-picked
   mapping at guest-orders.js:443-460 is EXTENDED, never reshaped — the module 14 rule).
6. **Admin orders tab (`routes/orders.js` `GET /cycle/:cycleId`, `requireAdmin`):** each
   friend order row gains `variable_symbol` (`friendOrderVariableSymbol(o.id)`) and each
   nested guest sub-order row gains `variable_symbol` (guest scheme). Placeholder rows
   (`status: 'none'`, no order) carry `variable_symbol: null`.

**Business rules:** no payload LOSES a field; no VS is computed outside `helpers/payment.js`;
the `transactions` table is untouched by everything in this module (row count pinned —
UC-PL-009 item 7). Guest and friend `amount` semantics are unchanged (`orders.total` +
`delivery_fee` for friends is computed client-side in `FriendOrder.paymentTotal`, as
today; guest `amount` = `total` until module 20).

**Acceptance criteria:** listed under UC-PL-001 plus: the mail text contains
`Variabilný symbol: 9000NNN` for the created order and no `payme.sk`/`revolut.me`; the
unpaid overview row's `variable_symbol` equals the guest's own `payment.variable_symbol` for
the same order (same helper, asserted across the two surfaces); a settled friend's balance
`payment.amount` is `0`, a friend at `-26.19` gets `26.19`.

---

## UC-PL-004 `frontend/src/lib/payment-links.js` — the one client home (system)

**Goal:** ONE implementation of "turn a payment block into links and a bysquare payload",
consumed by `PaymentModal.vue` (UC-PL-005/006) and by the friend success modal (UC-PL-007
item 1). No new dependency (01-architecture §Dependencies).

**Exports:**

| Export | Contract |
|---|---|
| `revolutLink(username, amount)` | `username` trimmed and stripped of a leading `@`, URL-encoded. Amount variant when `Number.isFinite(amount) && amount > 0`: `` `https://revolut.me/${u}?amount=${Math.round(roundMoney(amount) * 100)}&currency=EUR` `` (minor units — 26.19 → `2619`); otherwise the plain profile link `` `https://revolut.me/${u}` `` (the shipped href). Returns `''` for a blank username. |
| `paymeLink({ iban, amount, variableSymbol, reference, creditorName, date })` | `''` unless `iban` AND `creditorName` are non-blank AND `amount` is a finite positive number. Otherwise `https://payme.sk/?V=1&IBAN=<iban without whitespace, upper-case>&AM=<roundMoney(amount).toFixed(2)>&CC=EUR&DT=<YYYYMMDD>` + (`&PI=/VS<vs>/SS/KS` only when `variableSymbol` is non-empty) + `&MSG=<encodeURIComponent(reference.slice(0,140))>` (only when reference non-empty) + `&CN=<encodeURIComponent(creditorName)>`. `date` defaults to today (same `YYYYMMDD` derivation as `generateQr`). |
| `payBySquarePayload({ amount, iban, variableSymbol, reference, creditorName, date })` | the object today's `generateQr()`/`generateSuccessQr()` hand to `bysquare.encode()`, with **exactly two changes**: `variableSymbol: variableSymbol || ''` and `beneficiary.name: creditorName || 'Gorifi'` (D3). `amount: roundMoney(amount)`, `paymentNote: reference || ''`, `paymentDueDate` = today, everything else byte-identical (`invoiceId ''`, `constantSymbol ''`, `specificSymbol ''`, `originatorsReferenceInformation ''`, `bic ''`, `street ''`, `city ''`). Callers then `encode(payload, { version: Version['1.0.0'] })` and `QRCode.toDataURL(str, { errorCorrectionLevel: 'M', width: 256, margin: 2 })` exactly as shipped — those two calls stay where they are. |
| `REVOLUT_AMOUNT_LINK` | a boolean constant, `true`. ⚠ OPEN (R6.1, restated by the orchestrator): **the `?amount=&currency=` format must be verified on a real phone with the Revolut app before it is pinned** — Revolut has changed it before. If the amount variant does not prefill (or breaks the link), the first task flips this constant to `false`, which makes `revolutLink()` return the plain profile link for every amount; the button label then drops the amount (UC-PL-005). One line, one place. |

**Business rules:**

1. **Money leaves through `roundMoney` here, and only here on the client.** The shipped
   rule ("rounded at the payload, not in the caller" — `PaymentModal.vue` and
   `FriendOrder.paymentTotal`'s comment) is preserved: `paymentTotal` stays UNROUNDED,
   `payBySquarePayload` and the two link builders round. `money-rounding.spec.js`'s
   mutation-proof of the two encode sites therefore still has two distinct targets
   (component + success modal), both calling this helper.
2. The `@` strip and `encodeURIComponent` are the only transformations of the username; no
   lower-casing (Revolut handles are case-insensitive but the stored value is echoed).
3. `paymeLink` never emits a VS it was not given and never composes a reference — both come
   from the server (UC-PL-003). PayMe's `MSG` cap: 140 chars — OPEN: verify with the PayMe
   spec alongside the `CN` cap (UC-PL-002); adjust the `slice` if the published cap differs.
4. **Not admin code.** `lib/payment-links.js` imports `lib/money.js` (friend/guest-only per
   its header) and must never be imported by an admin view.

**Acceptance criteria:** covered through the surfaces (UC-PL-009): the rendered Revolut href
equals the helper's output for the payload amount; the PayMe href parses (`new URL`) with the
exact parameter set above and `AM` equal to the amount formatted with two decimals; the
scanned QR equals an independent encode that puts the server VS into `variableSymbol` and the
creditor name into `beneficiary.name`.

---

## UC-PL-005 `PaymentModal.vue` — amount-prefilled Revolut button (Friend, Guest)

**Goal:** R6.1 — one tap opens Revolut with the amount already filled in.

**Props (D4 — additive):**

| Prop | Type | Default |
|---|---|---|
| `open`, `amount`, `reference`, `iban`, `revolutUsername` | unchanged | unchanged |
| `variableSymbol` | String | `''` |
| `creditorName` | String | `''` |

Emits `close` and nothing else (unchanged). The `v-if="open"` mount, the `'-'` amount guard,
`NeoModal` title „Platba“, the subtitle, the footer „Zavrieť“, the × named „Zatvoriť
dialóg“ — all unchanged (the shipped guest specs query them unscoped).

**The Revolut control:** still an `<a class="btn block">` with the same inline colours,
glyph, `target="_blank" rel="noopener noreferrer"`; `href` = `revolutLink(revolutUsername,
amount)`. Label becomes **„Zaplatiť cez Revolut“** followed by the amount in a nested
`<span class="mono">` — `(26.19 EUR)` via `fmtEur` — when `amount` is truthy and
`REVOLUT_AMOUNT_LINK` is true; otherwise the bare shipped label. Accessible name therefore
starts with the shipped string, so every `getByRole('link', { name: /Revolut/ })` /
`{ name: 'Zaplatiť cez Revolut' }` (substring) lookup keeps matching.

**Business rules:**

- Rendered only when `revolutUsername` is non-blank (shipped gate).
- The `amount` in the label is the same number the link carries (`fmtEur(amount)` vs
  `Math.round(roundMoney(amount)*100)`) — a mismatch is a bug, pinned.
- `EUR` after the total (CLAUDE.md §Frontend: `€` on lines, `EUR` on totals).
- The QR generation `watch` now also re-runs on `variableSymbol`/`creditorName` changes
  (`[open, iban, amount, variableSymbol, creditorName]`) and builds its payload with
  `payBySquarePayload()`; the two status strings „Generujem QR kod...“ / „Nepodarilo sa
  vygenerovat QR kod.“ stay byte-identical (pinned by `guest-payment-modal.spec.js:283`).
- The component header comment's "byte-identical payload" and "FROZEN props" paragraphs are
  rewritten (D4) — they are now false and a future reader must not restore the old payload.

**Acceptance criteria:** from the guest status page with `payment.amount = 26.19` the
Revolut link's href is `https://revolut.me/<user>?amount=2619&currency=EUR` and its
accessible name contains `26.19 EUR`; with `REVOLUT_AMOUNT_LINK` false (implementer's
manual check, not e2e) the href is the plain profile link and the label has no amount.

---

## UC-PL-006 `PaymentModal.vue` — PayMe.sk button (mobile only) + VS copy row (Friend, Guest)

**Goal:** R6.2 — on a phone, a bank-app deep link with IBAN, amount, VS and message
prefilled; on desktop the QR stays the primary path. R6.3 — the VS is visible and copyable
for anyone typing the transfer by hand.

**Structure — body order becomes:** Revolut → **PayMe** → QR/IBAN → reference (+ VS row
inside the reference section).

1. **PayMe button** — `<a class="btn block" data-testid="payme-link">`, default ink/paper
   `.btn` colours (no brand colour — no prototype, no PayMe brand asset self-hosted; adding a
   remote image would break the CSP sweep), label **„Zaplatiť cez bankovú appku (PayMe)“**,
   `href = paymeLink({...})`, `target="_blank" rel="noopener noreferrer"`. **Rendered
   (`v-if`) only when ALL hold:** `paymeLink()` returned a non-empty string (⇒ `iban` and
   `creditorName` set, positive amount) AND the pointer is coarse:
   `useMediaQuery('(pointer: coarse)')` from `@vueuse/core` (pre-approved dependency, already
   installed). ⚠ `v-if`, not a CSS `@media` hide: `guest-payment-modal.spec.js:359-360` maps
   `.m-body`'s children by tag and pins `['revolut','qr','reference']` — an
   `<a>` present-but-hidden on desktop would be counted as a second `revolut` and redden the
   shipped test for nothing. With `v-if` the desktop DOM is unchanged and the phone case
   gets its own test (UC-PL-009 item 1c) in a `hasTouch: true` context (Chromium then
   matches `(pointer: coarse)`; if the harness proves otherwise, the fallback gate is
   `(pointer: coarse), (hover: none)` — recorded so the decision is not re-litigated).
2. **VS copy row** — inside the existing reference `div` (so the section count stays 3),
   AFTER the reference row: `label.field-lbl` **„Variabilný symbol“** + `NeoCopyRow
   :value="variableSymbol" small data-testid="payment-vs"`. Rendered only when
   `variableSymbol` is non-empty. ⚠ The existing `data-testid="payment-reference"` stays on
   the reference row ONLY (`guest-payment-modal.spec.js:408` reads its text and its single
   button); the new row has its own testid. Copy button label inside `NeoCopyRow` is the
   primitive's („Kopírovať“ → „Skopírované!“) — no new accessible name that contains another
   control's (the modal's substring-collision rule).
3. **Reference row label unchanged** („Poznámka k platbe (uveďte ju pri platbe)“).

**Business rules:**

- No PayMe without a creditor name (UC-PL-002 rule 1) — `paymeLink()` enforces it, the
  template only checks for a non-empty href.
- No PayMe on desktop: the QR is the desktop path (R6.2).
- The PayMe `AM` and the QR `amount` and the Revolut `amount` are the same rounded number
  for the same `amount` prop (one `roundMoney` per builder, same input).
- `DT` (PayMe) and `paymentDueDate` (bysquare) are both "today" from the same derivation.
- Slovak copy: impersonal vy-form; none of the strings addresses the reader with a
  participle.

**Acceptance criteria:** in a `hasTouch: true` 378 px context the PayMe link is visible, its
href parses with `V=1`, the whitespace-free IBAN, `AM=26.19`, `CC=EUR`, `DT` = today,
`PI=/VS9000NNN/SS/KS`, `MSG` = the decoded reference, `CN` = the decoded creditor name; in
the default (fine-pointer) context `payme-link` has count 0 and the `.m-body` order pin is
unchanged; the `payment-vs` row text equals `payment.variable_symbol` and its copy button
copies exactly that string; with a blank creditor name (settings PUT `''`) the PayMe link
is absent even under `hasTouch` and the QR's beneficiary decodes to `Gorifi`.

---

## UC-PL-007 The surfaces — friend order, guest confirmation, guest status, balance (Friend, Guest)

**Goal:** wire the new props through every caller; add the one new surface (balance).

1. **`FriendOrder.vue` (module 04):**
   - The `PaymentModal` mount (FriendOrder.vue:1893-1900) passes
     `:variable-symbol="paymentVs"` and `:creditor-name="paymentCreditorName"`, where
     `paymentVs` is the server's `payment.variable_symbol` from the last GET/PUT/submit
     response (UC-PL-003 item 3; `''` while `order` is null) and `paymentCreditorName` is
     loaded next to `paymentIban`/`paymentRevolutUsername` from `api.getPaymentSettings()`
     (`paymentSettings.paymentCreditorName || ''`).
   - **The success modal („Hotovo!“, 04 §UC-FO-011)** keeps its own QR and Revolut `<a>` but
     builds both through `lib/payment-links.js`: `generateSuccessQr()` encodes
     `payBySquarePayload({ amount: paymentTotal, iban: paymentIban, variableSymbol:
     paymentVs, reference: paymentReference, creditorName: paymentCreditorName })`; the
     inline `<a>`'s href becomes `revolutLink(paymentRevolutUsername, paymentTotal)` with the
     same amount-suffixed label as UC-PL-005. ⚠ No PayMe button and no VS row on the success
     modal — the success modal is a confirmation with a shortcut; the full payment surface is
     „Zaplatiť“ → `PaymentModal` (04's "one home for the string the friend must type into
     their bank" comment is updated accordingly: the VS row lives in the Platba modal only).
   - `paymentTotal` stays UNROUNDED (its comment is load-bearing; `money-rounding.spec.js`).
   - `paymentReference` stays `${friendName} / ${cycleName}` (D2).
2. **`GuestOrder.vue` (g-confirm)** — the mount passes
   `:variable-symbol="confirmation.payment.variable_symbol"` and
   `:creditor-name="confirmation.payment.creditor_name"`. The auto-open gate
   (`payment.iban || payment.revolut_username`) is unchanged. Payment data still comes ONLY
   from the submit response (06 §UC-GX-004).
3. **`GuestOrderStatus.vue` (g-status)** — same two props from `payment`; the `open-payment`
   trigger gate (`!isPaid && hasPaymentDetails`) is unchanged.
4. **Balance — NEW surface (D5), `FriendBalanceCard.vue` (03 §UC-FL-005 amended):**
   - The card reads `data.payment` from `api.getFriendBalance()` (UC-PL-003 item 4) into a
     `payment` ref.
   - A second button **„Zaplatiť“** (`button.btn.ok.sm`, `data-testid="pay-balance"`)
     renders BEFORE „Transakcie“ only when `balanceState === 'neg'` AND
     `(payment.iban || payment.revolut_username)`. Click ⇒ `showPayment = true`.
   - The card mounts `PaymentModal` (`v-if="payment"`) with `:open="showPayment"`,
     `:amount="payment.amount"`, `:reference="payment.reference"`, `:iban`,
     `:revolut-username`, `:variable-symbol="payment.variable_symbol"`,
     `:creditor-name="payment.creditor_name"`, `@close="showPayment = false"`. ⚠ It is
     mounted by the CARD, not inside `FriendTransactionsModal` — UC-DS-010 one-modal rule;
     `FriendTransactionsModal.vue` is untouched.
   - `close` does NOT re-run `loadBalance()`: paying through a link changes nothing in the
     ledger until the admin records it, and a reload would suggest otherwise. Nothing is
     written; no optimistic state.
   - OPEN (module 18 seam): the roadmap's portal IA (18) moves the balance into a „Zostatok a
     platby“ drawer item and redesigns the landing. This card and its trigger are what 18
     relocates — 18 must reuse `FriendBalanceCard`'s trigger + mount, not add a second
     `PaymentModal` for the balance. The "debt banner on the landing (default yes)" of
     00-overview is 18's; if it links to payment, it opens THIS modal.

**Business rules (all surfaces):** the component never composes a VS or a reference — props
in, links out; a surface whose payload has no `variable_symbol` (e.g. a stale cached
response) renders today's modal (no VS row, VS-less QR) rather than a made-up symbol; no
`transactions` write anywhere in this module.

**Acceptance criteria:** the friend cart-bar „Zaplatiť“ modal shows `payment-vs` equal to the
order's id and a Revolut href with `amount=`; the success modal's scanned QR decodes to
`variableSymbol === String(order.id)`; the guest confirmation and status modals show
`9000NNN`; a friend at `-26.19` sees „Zaplatiť“ on the balance card and the modal's subtitle
reads `Suma na úhradu: 26.19 EUR` with VS `8000FFF`; a settled friend sees no „Zaplatiť“;
the `transactions` row count is unchanged after opening/closing every one of these modals.

---

## UC-PL-008 Admin sees the VS next to every reference (Admin)

**Goal:** the admin matching a bank statement line `VS 9000123` can find the order without
decoding the scheme in their head.

- **`CycleDetail.vue`, receivables card** (the „Nezaplatené objednávky hostí“ and „Na
  vrátenie“ lists, CycleDetail.vue:1895 / :1928): the existing `text-xs font-mono` reference
  line gains a prefix **`VS {{ row.variable_symbol }} · `** before `{{ row.reference }}`
  (one line, mono, shadcn utilities; no `neo/` class).
- **`CycleDetail.vue`, orders tab:** friend order rows and nested guest rows render a muted
  mono **`VS {{ row.variable_symbol }}`** where the row already shows its money/paid state;
  placeholder rows (`variable_symbol: null`) render nothing. OPEN: exact placement is the
  implementer's call within the existing row; the PO may prefer it only on the receivables
  card — default recorded: both.
- **Nothing else:** no VS filter/search, no statement import — F6 is links + symbol, not
  reconciliation.

**Acceptance criteria:** the receivables card text contains `VS 9000NNN` for the fixture's
unpaid guest order and its refund row after an admin cancel; the orders tab row of the
fixture friend contains `VS <order id>`; no `neo/`/`pp-*` class appears in the
`CycleDetail.vue` diff (admin invariance gate).

---

## UC-PL-009 Verification — e2e obligations and sanctioned edits (system)

**Goal:** name every shipped assertion this module supersedes (each edit re-points a pin at
the mandated behaviour and cites the UC in a comment — 03 §UC-FL-013 case (a)) and what the
new spec must pin. Money paths use the pixel-QR technique (01-architecture §Testing & gate:
"changing the bysquare payload is a sanctioned edit to that spec, listed per module").

**1. `guest-payment-modal.spec.js` — SANCTIONED EDITS (the pixel-QR contract, R6.4):**
   - (a) `independentQr()` (:215-249) takes `variableSymbol` and `creditorName` and encodes
     `variableSymbol`, `beneficiary.name: creditorName || 'Gorifi'`; the call at :270 feeds
     `guestOrder.payment.variable_symbol` / `.creditor_name`; new decode asserts
     `pay.variableSymbol === '9' + String(guestOrder.order.id).padStart(6,'0')` and
     `pay.beneficiary.name === guestOrder.payment.creditor_name`. `:279` (the reference
     string) stays verbatim (D2).
   - (b) `:366` href equality retargets to
     `` `https://revolut.me/${user}?amount=${Math.round(amount*100)}&currency=EUR` ``; the
     accessible-name lookups (`/Revolut/`) stay.
   - (c) NEW tests in this file: a `browser.newContext({ hasTouch: true, viewport: PHONE })`
     case asserting `payme-link` visible + the parsed URL params (UC-PL-006 AC); the default
     context asserting `payme-link` count 0 and the unchanged `['revolut','qr','reference']`
     order (:359-360 passes UNMODIFIED); the `payment-vs` row (text + clipboard, the
     share-dialog clipboard-permission idiom).
   - (d) The file header's "carried over byte-identically" paragraph is rewritten to cite
     UC-PL-004/005/006.
**2. `money-rounding.spec.js` — SANCTIONED EDIT:** `independentQr()` (:594-624) adds
   `variableSymbol: String(order.id)` (the test already has `order`); `beneficiary` stays
   `'Gorifi'` because its `payment-settings` mock (:693-696) carries no creditor name (D3
   fallback — leave the mock as is; that absence is now ALSO what the test proves). The
   drifting-vs-rounded amount logic is untouched.
**3. `order-modals.spec.js`:** `:881`'s `toMatch(/^https:\/\/revolut\.me\//)` and `:877`'s
   name lookup pass unmodified (query string and amount suffix are compatible). NO edit —
   if one proves necessary, it is a regression in the implementation, not a sanctioned edit.
**4. `guest-order-recovery.spec.js`:** NO edit required — every reference pin (`:508, :599,
   :2825, :2827, :2848, :2920`) and the no-`revolut.me`-in-mail pins (`:2831, :2854`) stay
   true. The mail describe MAY gain one additive assertion: `fields.text` contains
   `Variabilný symbol: ${created.payment.variable_symbol}` (UC-PL-003 item 2).
**5. `api-security.spec.js`:** NO edit — no new admin route; `/api/admin/payment-settings`
   stays in the public list. `self-hosted-fonts.spec.js`: NO edit — no new route, no
   external subresource (the PayMe/Revolut `<a>` are navigations, not requests, exactly like
   the shipped Revolut link at :470).
**6. `e2e/seed.mjs` 3b:** adds `paymentCreditorName: 'E2E Podpultovka'` to the payment
   settings body and to the "already present" check (`!json.paymentCreditorName` joins the
   condition so an existing seed DB gets the third key). Hermetic specs that set their own
   settings (`guest-order-recovery.spec.js:2719-2721` `setIban/setRevolut`) are unaffected.
**7. NEW `e2e/tests/payment-links.spec.js`** (fixtures per test, no shared `beforeAll` — the
   GSO-T8 lesson):
   - VS scheme API pins (UC-PL-001 AC) across guest 201 / both status forms / friend
     GET-PUT-submit / balance / unpaid overview / orders tab — same helper, equal values
     across surfaces.
   - Settings: 70 ok / 71 → 400 + read-back unchanged / `true` → 200 + unchanged / public
     endpoint carries the name / `maxlength="70"` in the admin UI.
   - Friend cart-bar modal: Revolut href + label amount; `payment-vs` = order id; success
     modal scanned QR decodes with `variableSymbol === String(order.id)` (reuse
     `readModules` — lift it into a shared e2e helper file rather than a third copy).
   - Balance: `-26.19` shows „Zaplatiť“ → modal subtitle `26.19 EUR`, VS `8000FFF`; settled
     friend: no button; ⚠ `transactions` count before/after every modal interaction —
     unmoved.
   - Admin: `VS 9000NNN` on the receivables card; `VS <id>` on the orders tab; admin
     invariance grep on `CycleDetail.vue`.
   - Blank creditor name ⇒ no PayMe under `hasTouch`, QR beneficiary `Gorifi`.
**8. Procedure:** `node --check` on every changed backend file (no unit runner — do not add
   one); targeted files first (`payment-links`, `guest-payment-modal`, `money-rounding`,
   `order-modals`, `guest-order-recovery`, `api-security`, `self-hosted-fonts`,
   `portal-transactions-modal`), `--workers=1`, output to a file, full suite only at the
   module milestone with all five `RATE_LIMIT_*_MAX` raised.

---

## Deferred / dropped (named so they are not silently built)

- **R6.5 „Zaplatil(a) som“ self-report** — DEFERRED (roadmap §6 default). If revived: a
  flag on `orders`/`guest_orders` that the admin's paid toggle consumes, **no ledger
  write**, and the label must be re-cast in the impersonal register („Platba odoslaná“) —
  the roadmap's participle form is not usable as UI copy.
- **Bank-statement import / auto-reconciliation** — not in F6.
- **A stored `payment_vs` column** — rejected (D1).
- **Revolut/PayMe links in e-mail or WhatsApp** — module 21 decides; the mail keeps
  username + VS as text (08 one-origin pin).

## Accepted risks

- The Revolut amount-link format is unverified until the first task tests it on a phone
  (UC-PL-004 `REVOLUT_AMOUNT_LINK`); the fallback is the shipped plain link, so the worst
  case is today's behaviour.
- PayMe `CN`/`MSG` caps are recalled, not verified (UC-PL-002/004 OPEN); both bounds are
  single constants.
- `(pointer: coarse)` is a heuristic for "has a banking app": a touch laptop sees the PayMe
  button and a phone in desktop mode does not. The QR and Revolut paths remain on every
  device, so nobody is left without a way to pay.

## PO decisions 2026-09-19 — OPEN items resolved

> Recorded by the orchestrator from the PO walkthrough. Each line resolves the `OPEN:` of the same name above; where a default was overturned the affected UC carries an amendment note.

- **Balance reference text** = `„{Meno} / zostatok“` (default kept).
- **Admin VS placement** = receivables card AND orders tab.
- **Verification tasks, not decisions (PO does them on a phone before pinning):** Revolut `?amount=&currency=` format (keep the `REVOLUT_AMOUNT_LINK` fallback flag until verified); PayMe `CN` 70 / `MSG` 140 caps against payme.sk.
- **Module 18 seam** stands: the balance „Zaplatiť“ trigger is relocated by 18, not duplicated.
- R6.5 „Zaplatil(a) som“ stays deferred.
