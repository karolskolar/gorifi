# 20 — Packeta delivery for guests

> Scope: A guest (colleague ordering through a host's share link) can choose, at checkout
> and later in edit mode, to have their bag **sent by Packeta** instead of collected from
> the host — but only when the cycle allows parcels (`order_cycles.parcel_enabled = 1`).
> This module adds the two money/delivery columns to `guest_orders`
> (`delivery_fee REAL DEFAULT 0`, `packeta_address TEXT` — the friend columns mirrored), the
> checkout choice „Prevezmem od {host}“ (default) / „Poslať Packetou (+{fee})“ with a
> free-text point (≤ 160 chars, no Packeta widget/API) and a **mandatory e-mail when
> Packeta is chosen**, the fee copied from `cycle.parcel_fee` at submit and re-read on
> every switch, the amount to pay = `total + delivery_fee` on every surface (confirmation,
> status page, QR, module 15's payment links, the confirmation mail, host card, admin
> views), the edit/cancel rules (items frozen when paid — the delivery method with them;
> cancel zeroes the fee), the admin correction of a guest's delivery back to „cez {host}“
> through `helpers/pickup.js` (ledger-neutral by construction — guests have no ledger),
> and the host / admin / distribution surfaces (red „Packeta“ badge, point + phone, the host
> copy „tento kolega dostane balík Packetou“). A guest with `packeta_address` becomes **its
> own party** of delivery type `packeta` — no longer a bag inside the host's bag.
> Out of scope (handoffs): **friend Packeta** (exists — `orders.js:338-380`, 04 §UC-FO-010);
> **hand-over / distribution board / `helpers/delivery.js` classification** → module 16
> (this module only guarantees the columns 16 classifies on, and hands 16 the "Packeta guest
> is its own party, never `via_host`" rule); **WhatsApp „Odovzdané Packete“ message** →
> module 21; **payment link formats / variable symbol** → module 15 (consumes `payment.amount`
> as published here); **Packeta widget / API / tracking numbers** → not on the roadmap
> (roadmap §16 Q4.b); **friend e-mail becoming required for Packeta** → module 18 (§19 of the
> roadmap says "same rule for friends" — that is the friend profile's concern).
> Actors: **Guest** — public, unauthenticated, the URL token is the credential; every
> input here is hostile (GSO-T3 bounds apply, new bound 160 on the point). **Friend
> (host)** — read-only on the Packeta state; loses the hand-over tick on a Packeta
> sub-order (nothing to hand over); never writes a Packeta column. **Admin** — sees the
> point + phone everywhere, may switch a guest back to „cez {host}“ (the one write, via
> `pickup.js`), stays the sole owner of `paid`; never sets a Packeta address for a guest in
> v1 (OPEN below).
> Sources: `docs/superpowers/specs/2026-09-03-roadmap-requirements.md` §4 (F4, R4.1–R4.8 —
> the requirement), §16 decisions Q4.a/b/c (same fee as friends = cycle `parcel_fee`;
> free text, no widget; host need not order), §11 vocabulary (delivery types, "a guest who
> chose Packeta is its own bag and its own party"), §18 row 8 (depends on 15 and 16a),
> §19 (e-mail help text „Packeta naň posiela informácie o zásielke“);
> `docs/specification/00-overview.md` §Scope extension — roadmap October 2026 + row 20;
> `docs/specification/01-architecture.md` §Roadmap additions (`guest_orders.delivery_fee`,
> `packeta_address`, "cancel zeroes the fee; no `transactions` row ever"), §Permissions,
> §Testing gate notes (pixel-QR approach, sanctioned spec edits listed per module);
> `docs/superpowers/specs/2026-05-01-packeta-parcel-delivery-design.md` (the FRIEND
> Packeta design — mirrored field by field, incl. its §Edge Cases);
> `docs/learnings/02-guest-shared-orders.md` (GSO-T3 bounds, T4 identity freeze + literal
> `items: []` cancel, T5 single-owner flags, T6 no-ledger + paid freeze, T7 packed gate,
> T8 aggregation split, T9 rewards, T10 `validateIdentity` shared with the CTA); repo
> `CLAUDE.md` §Money & data (guests have NO ledger; `total` product-only; `delivery_fee`
> separate; one-home helpers; `pickup.js`; guest bounds); repo code —
> `backend/src/routes/guest.js` (submit :737-842, `statusPayload` :411-475,
> `handleStatusEdit` :880-1050, `validateIdentity` :119-156, `deliverOrderConfirmation`),
> `routes/guest-orders.js` (host/admin routes, `/unpaid` :419-470), `routes/orders.js`
> (:338-380 friend Packeta submit; :582-655 admin pickup PATCH — the mirror), `routes/cycles.js`
> (`/:id/public` :152, `/:id/distribution` :521-620), `helpers/guest-orders.js`
> (`GUEST_ORDER_FIELDS`, `softCancelGuestOrder`, `guestPaymentReference`), `helpers/pickup.js`
> (`applyPickup` Packeta clearance), `helpers/packing.js` (`packingItemStats`),
> `db/schema.js` (guest tables :963-995), `frontend/src/views/GuestOrder.vue`,
> `GuestOrderStatus.vue`, `components/GuestSubOrders.vue`, `PaymentModal.vue`,
> `PickupLocationPicker.vue`, `views/Distribution.vue`, `views/CycleDetail.vue`,
> `views/FriendOrder.vue` (:82-122, :301-343 — `deliveryLines`, `paymentTotal`);
> `docs/specification/06-guest-flow.md` (UC-GX-003..008 — the shipped guest screens this
> module extends), `14-guest-order-recovery.md` (format + UC-GR-011 mail + the
> `GUEST_ORDER_FIELDS` one-list rule), `05-colleagues-panel.md` (UC-KG-003/004 — the card
> and the hand-over tick), `04-friend-order.md` (UC-FO-010 — the friend delivery modal whose
> structure the guest choice mirrors). The most recent decision wins on conflict.
> **Design reference:** no prototype screen exists for the guest checkout choice or the
> Packeta status state. Guest-surface additions compose from module 02 primitives inside
> module 06's shipped structures, mirroring 04 §UC-FO-010's method radios; the fee badge
> wording follows `docs/design/friends-portal-redesign/friends/portal2.jsx:160` („+{fee}“,
> `badge acc-o`). Host additions sit inside 05 §UC-KG-003's card. Admin additions keep the
> shadcn look (Packeta = `border-red-400 text-red-600 bg-red-50`, the shipped friend badge).
> Module 16's board prototype (`admin2.jsx`, the `packeta` group with a `kind: "guest"` bag
> „cez {host}“) is the target layout for the Packeta group; this module only guarantees the
> payload it renders from.

---

## Resolved conflicts (recency / canonicity)

1. **R4.7 "cancelling zeroes `delivery_fee` too" vs the refund queue's item-recomputed
   `amount` (GSO-T6).** R4.7 and 01-architecture (newer, PO-reviewed) win: the fee IS
   zeroed on cancel. Consequence recorded, not hidden: a paid Packeta sub-order that is
   cancelled lands in the refund queue with `amount` = items only — the fee the guest paid
   has no row to be recomputed from. UC-GP-006 therefore keeps `packeta_address` on the
   cancelled row (the record, like the item rows) and publishes `packeta: true` on the
   refund row so the admin knows a fee is owed back on top. Whether the refund `amount`
   should include the fee (which needs a column that survives cancel) is `OPEN:` below.
2. **GSO-T4 "identity is frozen on edit" vs R4.3 "e-mail mandatory when Packeta".** A guest
   who submitted „Prevezmem od {host}“ without an e-mail and later switches to Packeta in
   edit mode has no e-mail to require. Resolution (spec-author decision D3, PO sign-off
   `OPEN:`): the edit PUT may **set `guest_email` once, only when it is currently NULL and
   `use_parcel_delivery === true`**. It is a write-once addition, never a rewrite — the
   freeze exists so a URL holder cannot rewrite *somebody else's* contact details, and an
   existing e-mail stays immutable. The alternative (409 the switch) recreates the "ask
   the admin" dead end module 14 was written to remove.
3. **"Paid ⇒ items frozen" — does the delivery method freeze with them?** Yes (orchestrator
   default adopted, D2): changing pickup ↔ Packeta changes what is owed (the fee) exactly
   as an item edit does, and GSO-T6's guard exists because there is nowhere to record a
   different amount after `paid`. Cancel stays allowed (the literal `items: []`).
4. **Friend design "updates pick up the current fee" vs "fee frozen at submit".** Friend
   rule wins (R4.5 says "follows the friend rules"): the stored fee never changes on its
   own; every PUT that CARRIES `use_parcel_delivery: true` re-reads `cycle.parcel_fee`
   (whether or not the method actually switched). A PUT that omits the delivery fields
   leaves both columns untouched (API-additive — the shipped items-only PUT keeps working
   byte-identically).
5. **New guest-facing copy never says „cyklus“** (roadmap §16 R1.6, module 18) — so the
   friend route's ~~`'Doručenie Packetou nie je pre tento cyklus dostupné'`~~ is NOT copied
   verbatim (⚠ PI-T11 re-worded the friend route to the guest string below, so the two now match); the guest string is `'Doručenie Packetou nie je pre túto objednávku dostupné'`.
   Shipped guest strings that already say „cyklus“ are left alone (not this module's).

---

## UC-GP-001 Schema, shared field lists, published cycle flags (system)

**Goal:** the two columns exist on prod and every surface that lists a sub-order carries
them; the guest surface learns whether parcels are on and what they cost.

**Schema (`backend/src/db/schema.js`, the guest tables block :963-995):**

| Column | Type | Rule |
|---|---|---|
| `guest_orders.delivery_fee` | `REAL DEFAULT 0` | the parcel fee charged for THIS sub-order, copied from `order_cycles.parcel_fee` through `roundMoney()` at write time; 0 when not Packeta; **never** part of `total` |
| `guest_orders.packeta_address` | `TEXT` (nullable) | the free-text Packeta point (Z-BOX / branch + town), trimmed, ≤ 160; NULL when not Packeta |

- Both go into the `CREATE TABLE IF NOT EXISTS guest_orders` statement **and** a
  try/catch `ALTER TABLE guest_orders ADD COLUMN …` pair (CLAUDE.md: a column on a table
  already in prod needs CREATE **and** ALTER; GSO-T2's "no migrations for guest tables"
  refers to the tables' existence, not to new columns — 01-architecture §Roadmap additions
  is explicit).
- Invariant, stated for every consumer: **`packeta_address IS NOT NULL ⇔ the sub-order is a
  Packeta bag.** `delivery_fee > 0` alone is not the marker (a cycle fee of 0 is legal, and
  cancel zeroes the fee while keeping the address — UC-GP-006). `helpers/delivery.js`
  (module 16) classifies on the address; so does everything here.

**Shared lists (additive, never reshaped):**

- `helpers/guest-orders.js` `GUEST_ORDER_FIELDS` **+= `'delivery_fee', 'packeta_address'`**
  (the D6 one-list rule from module 14: host view, both admin surfaces, every mutation
  payload get the columns at once). The hand-picked `/unpaid` mapping in
  `routes/guest-orders.js:437-456` is extended by name with the same two fields (UC-GP-004).
- `routes/guest.js` carries THREE hand-picked column lists that must gain the two columns:
  `resolveGuestOrderByOrderToken` (:365), `loadOrder` (:241) and the resolver's twin if any
  remains (grep `guest_email, status, total` in the file — every hit). `statusPayload.order`
  and the submit's `order` therefore publish `delivery_fee` + `packeta_address`.
- `cycles.js` `/:id/distribution` and `orders.js` `/cycle/:cycleId` (admin) inherit the
  columns through `cycleSubOrders()`; the synthetic rows in UC-GP-010 name them.

**Published cycle flags (guest surface):**

- `GET /api/guest/:token` (`routes/guest.js:497-522`) `cycle` block **+= `parcel_enabled`
  (0/1) and `parcel_fee` (number, already rounded at the admin write — `cycles.js:377`)**.
  Not secrecy: both are already public on `GET /api/cycles/:id/public` (`cycles.js:153`),
  the GSO-T3 layering argument applies verbatim.
- `statusPayload.cycle` (:422-429) **+= the same two fields** — edit mode needs them.
- `POST /:token/orders` re-reads the cycle row server-side; the client value is display only.

**Business rules:**

- No new table, no new index, no change to `guest_order_links` (the host's pickup store is
  untouched — a Packeta guest has no pickup point and no link-level state).
- `total` stays product-only on every write in this module; **no reader of `total` changes**
  (stock, pricing, packing counts, `guestCycleItems`, rewards, `unpaid_count` — the
  GSO-T8/T9 seams are untouched by construction). The only new money column is
  `delivery_fee`, and the only readers that add it are the ones UC-GP-004 names.

**Acceptance criteria:** after a backend restart on a DB that predates the module, both
columns exist with `0`/`NULL` on every existing row; `GET /api/guest-links/cycle/:id`,
the admin orders tab, `/distribution` and `/unpaid` all carry `delivery_fee` and
`packeta_address` on every sub-order row; `GET /api/guest/:token` carries
`cycle.parcel_enabled` / `cycle.parcel_fee`.

---

## UC-GP-002 Checkout — the submit contract `POST /api/guest/:token/orders` (Guest)

**Goal:** the public submit accepts the delivery choice under the GSO-T3 hostile-input
contract, mirroring the friend submit (`orders.js:338-380`) field by field.

**Body (additive to the shipped `{ guest_name, guest_phone, guest_email?, items }`):**

| Field | Type / rule | 400 message (Slovak, vy-form) · `field` |
|---|---|---|
| `use_parcel_delivery` | absent / `null` / `false` ⇒ „Prevezmem od {host}“; **boolean `true`** ⇒ Packeta; **any other type or value** (`'true'`, `1`, `[true]`, `{}`) ⇒ 400 | `'Neplatný spôsob prevzatia'` · `use_parcel_delivery` |
| `packeta_address` | required when Packeta: `typeof === 'string'` **and** non-blank after `trim()` (the FUP-T12 fold — a number/object never reaches `.trim()`); stored trimmed; ≤ **160** chars after trim | `'Zadajte výdajné miesto Packety'` · `packeta_address` / `'Výdajné miesto je príliš dlhé (najviac 160 znakov)'` · `packeta_address` |
| `guest_email` | **required when Packeta** (R4.3): after `validateIdentity()` has passed, `identity.email` must be non-null; when Packeta it must also match the mailer's `EMAIL_SHAPE` (`helpers/mailer.js:39` — **export it**, one home; the same regex the confirmation mail's plausibility gate uses) | `'Pri doručení Packetou zadajte e-mail'` · `guest_email` / `'Neplatný e-mail'` (the existing string) · `guest_email` |

**Business rules:**

1. **Gate order** (each is a 400 that writes nothing): identity via the SHARED
   `validateIdentity()` (⚠ UNCHANGED — it is shared with the invite CTA, GSO-T10; the
   Packeta e-mail rule is a **separate check in the submit handler**, after it) → the
   delivery block above → `priceRequestedItems` → empty cart → stock. Parcel availability
   is checked BEFORE the address: `use_parcel_delivery === true` while
   `cycle.parcel_enabled` is falsy ⇒ 400 `'Doručenie Packetou nie je pre túto objednávku
   dostupné'`, `field: 'use_parcel_delivery'` (resolved conflict 5).
2. **The write** (inside the existing insert transaction, after the cycle-open re-read):
   the `INSERT INTO guest_orders` names the two literal columns —
   Packeta: `delivery_fee = roundMoney(cycle.parcel_fee || 0)`, `packeta_address = <trimmed>`;
   otherwise `delivery_fee = 0`, `packeta_address = NULL`. `total` is written exactly as
   today (`replaceItems` → product sum). ⚠ `cycle.parcel_fee` is re-read from the cycle row
   INSIDE the transaction together with `status` (the admin may change the fee mid-request;
   the same re-read the friend route lacks is cheap here and closes the drift).
   `roundMoney` is `helpers/pricing.js`'s (one home) — an unrounded fee would seed the QR
   drift the friend route's comment warns about.
3. **Q4.c — the host need not have ordered.** Nothing gates on the host's own order (the
   share link exists per cycle regardless). Stated so nobody adds it.
4. **No `transactions` row** — the handler never touches that table (guests have no ledger;
   the e2e pins `MAX(transactions.id)` unmoved across the submit).
5. **Response 201** (UC-GP-004 owns the amount): `order` (with the two columns), `items`,
   `payment.amount = roundMoney(order.total + order.delivery_fee)`, `payment.reference`
   (`guestPaymentReference()` — **unchanged**, R4.2), `status_path` as today.
6. **Rate limit:** the existing `guestWriteLimiter`; no new bucket (CLAUDE.md: never
   collapse, never add without a reason of its own — none here).
7. **Synchronous handler stays synchronous** — no `async`/`await` (14 §UC-GR-011's gated
   rule: `guest-order-recovery.spec.js` reads `routes/guest.js` off disk and asserts zero
   occurrences; the confirmation mail remains the post-response floating promise).
8. Unbindable body shapes (`{}`, `true`, `[1]`, `'abc'`) for the whole body or any field
   above must 400, never 500 (CLAUDE.md; the one-element array is the trap).

**Acceptance criteria:** a Packeta submit persists `delivery_fee === roundMoney(parcel_fee)`,
`packeta_address === trimmed input`, `total === Σ price×qty` (row read back, not the
response); a default submit persists `0`/`NULL` and its 201 body is byte-identical to
today's except for the two new `order` fields and `cycle` flags; every 400 above writes no
row (`COUNT(*)` unmoved) and names its `field`.

---

## UC-GP-003 Checkout — the delivery choice in `GuestOrder.vue` (Guest)

**Goal:** the checkout modal (06 §UC-GX-003) offers the choice only when the cycle allows
parcels, defaults to hand-over by the host, and mirrors every server bound as `maxlength`.

**New one-home component `frontend/src/components/GuestDeliveryChoice.vue`** (consumed by
the checkout modal AND the status page's edit mode, UC-GP-007 — extend, never fork):

- Props: `modelValue` (`'via_host' | 'packeta'`), `packetaAddress` (v-model:packeta-address),
  `hostFirstName`, `parcelFee` (Number), `parcelEnabled` (Boolean). Emits the two updates.
- Renders nothing when `parcelEnabled` is false (the shipped modal is then byte-identical
  on screen — the checkout e2e passes unchanged for a parcel-off cycle).
- Structure (module 02 primitives; the method radios mirror 04 §UC-FO-010's row markup):
  `span.field-lbl` **„Spôsob prevzatia“**; two radio rows —
  **„Prevezmem od {hostFirstName}“** (value `via_host`, default) and
  **„Poslať Packetou“** `<span class="sub">(+{fmtEur(parcelFee)})</span>` (value `packeta`;
  `€` because a fee is a line, not a total — the CartLineList money rule). When `packeta`:
  `label.field-lbl` **„Výdajné miesto Packeta *“**, `input.inp` `id="guest-packeta-address"`
  `data-testid="guest-packeta-address"` placeholder **„napr. Z-BOX Hlavná 15, Bratislava“**
  (the friend design's placeholder) **`maxlength="160"`**, `.field-help` **„Názov Z-BOXu
  alebo pobočky a mesto. Balík vám doručí Packeta, nie {hostFirstName}.“**
- `data-testid="guest-delivery-via-host"` / `"guest-delivery-packeta"` on the two radio
  inputs.

**Checkout modal changes (`GuestOrder.vue`, inside the existing `NeoModal`):**

1. `GuestDeliveryChoice` sits **below Mobil and above E-mail** (the e-mail label depends on
   the choice).
2. E-mail label flips: `via_host` ⇒ **„E-mail (nepovinné)“** (shipped); `packeta` ⇒
   **„E-mail *“** + `.field-help` **„Packeta vám naň pošle informácie o zásielke.“**
   (roadmap §19 wording, recast). The input keeps `maxlength="160"`.
3. Subtitle: `Suma na úhradu: <b class="mono">{fmtEur(cartTotal + fee)}</b>. Platba
   prevodom, ` + (`via_host` ⇒ `tovar vám odovzdá {host}.` — shipped; `packeta` ⇒
   **`balík vám doručí Packeta.`**), where `fee = deliveryMethod === 'packeta' ?
   cycle.parcel_fee : 0`. The cartbar's `cart-total` stays product-only (it is the cart, not
   the invoice — the friend cartbar shows the fee as a separate line, 04 §UC-FO-009:569; the
   guest cartbar has no such line and this module adds none: the subtitle is where the
   amount is stated).
4. Client-side validation, in `validateIdentity()`'s shipped position (server re-validates —
   Decision 7): when `packeta` — blank point ⇒ **„Zadajte výdajné miesto Packety.“**; blank
   e-mail ⇒ **„Pri doručení Packetou zadajte e-mail.“**; e-mail failing the same shape
   regex (mirror `EMAIL_SHAPE` in `lib/`; one constant, imported by both screens) ⇒
   **„Zadajte platný e-mail.“**. Messages render in the shipped `checkout-error` banner.
5. Payload: `use_parcel_delivery: true` + `packeta_address: <trimmed>` only when `packeta`;
   otherwise **neither key is sent** (the shipped payload stays byte-identical — the
   `guest-order.spec.js` request-shape pins hold for a via_host submit).
6. Hero card (06 §UC-GX-001 item 4): when `cycle.parcel_enabled`, the badge row gains a
   fourth `span.badge.acc-o` **„Packeta +{fmtEur(parcel_fee)}“** (portal2.jsx:160 wording).
   `OPEN:` PO sign-off on this and every other drafted string in this UC.
7. Modal reset on open: method `via_host`, point `''` (no profile to prefill from — guests
   have none; the friend's "save as default" checkbox has no guest counterpart and is NOT
   added).
8. The 320 px footer measurement (`GuestOrder.vue` style block) is untouched — no footer
   copy changes.

**Acceptance criteria:** with `parcel_enabled = 0` the modal DOM is unchanged; with it on,
the default submit sends no delivery keys; choosing Packeta reveals the point field
(`maxlength` 160) and makes the e-mail label „E-mail *“; the three client messages appear
without a request; a valid Packeta checkout reaches g-confirm with the fee (UC-GP-004).

---

## UC-GP-004 Amount to pay = `total + delivery_fee` on every surface (Guest, Host, Admin)

**Goal:** one rule, applied at every place a guest amount is stated: **amount to pay =
`roundMoney(total + delivery_fee)`; `total` stays product-only** (R4.2 — "mirrored in the
QR, the payment links and the status page"). Module 15's links consume `payment.amount`
and need no knowledge of the fee.

| Surface | Change |
|---|---|
| Submit 201 `payment.amount`, `statusPayload.payment.amount` (`guest.js:441-446`, :806-811) | `roundMoney(order.total + (order.delivery_fee || 0))` (was `order.total`). Reference unchanged. |
| `PaymentModal.vue` | **no change** — ~~props frozen (06 §UC-GX-005)~~ **the props are ADDITIVE, not frozen, since PL-T3 (15 §UC-PL-004/D4): `variableSymbol` + `creditorName` joined them.** The conclusion is unchanged and now rests on a different fact: this module changes only the `amount` the surfaces already pass, and `GuestOrder.vue`/`GuestOrderStatus.vue` already forward the two module-15 props. The bysquare payload therefore carries the fee-inclusive amount — a sanctioned pixel-QR spec addition (UC-GP-011). ⚠ GP-T1 must NOT re-inline the payload: it is composed by `frontend/src/lib/payment-links.js` (`payBySquarePayload`), shared with the friend success modal. |
| g-confirm sum card (06 §UC-GX-004 item 2) | item lines → **new line** `Doručenie Packetou` ↔ `span.mono` `toFixed(2)` (the friend `deliveryLines` label, FriendOrder.vue:306) rendered only when `order.delivery_fee > 0`; „Suma na úhradu“ shows `payment.amount`. Below the card: `.sub` **„Balík vám doručí Packeta: {packeta_address}“** when Packeta. `data-testid="confirm-delivery-fee"` on the fee line. |
| Confirmation mail (14 §UC-GR-011, `deliverOrderConfirmation`) | The fee is NOT an item line (`itemLines` untouched). When fee > 0 add its own `kv` row **after** the item lines and before `Spolu`: label `MAIL_DELIVERY_LABEL = 'Doručenie Packetou'`, value `<fee> €`; the `MAIL_TOTAL_LABEL` and `MAIL_AMOUNT_LABEL` values become `eur(payment.amount)` (fee-inclusive — for a via_host order that equals `order.total`, so today's mail is byte-identical); one more `kv` row `MAIL_PACKETA_LABEL = 'Výdajné miesto'` ↔ address when Packeta. The plain-text part carries the same lines in the same order. New constants are ADDITIVE (existing ones and their spec mirrors untouched). |
| Host card total (`GuestSubOrders.vue` `.foot .total`) | `formatPrice(subOrder.total + (subOrder.delivery_fee || 0))`; when fee > 0 a `.sub` under it: `({formatPrice(total)} + {formatPrice(delivery_fee)} doručenie)` (the admin table's wording, `CycleDetail.vue:2104`). `totals` (`{count, total}`) **stays product-only and unchanged** — it is the pinned GSO-T5 shape and a context figure („Kolegovia platia priamo správcovi“), not a charge. |
| Admin nested row (`CycleDetail.vue:2224-2300`) | amount cell = `total + delivery_fee` with the same breakdown sub-line as friend rows (:2102-2105). |
| Admin `/unpaid` (`guest-orders.js:437-456`) | row **+= `delivery_fee`, `packeta_address`, `packeta: !!packeta_address`**; `amount` for a live row = `roundMoney(total + delivery_fee)`; for a cancelled (refund) row stays `itemsAmount(row)` (resolved conflict 1). `totals`/`refund_totals` sum `amount` as today. |
| Cycle-level aggregates (`guestCycleItems`, `/summary`, kg, value, rewards, `unpaid_count`) | **untouched** — they are product/kg figures. ⚠ If any cycle-level "delivery fees" sum is ever displayed it must fold guest fees in via the JS-merge rule, never a JOIN; none exists today and none is added (not asked). |

**Business rules:**

- Cancelled: `total = 0` and `delivery_fee = 0` (UC-GP-006) ⇒ `payment.amount = 0` — the
  shipped `'-'` guard in `PaymentModal` and the status page's no-pay state cover it.
- `formatPrice`/`fmtEur` conventions hold: `€` on lines, `EUR` on totals.
- No surface composes the amount from the client's cart — it is always the server's
  `payment.amount` or the row's two columns.

**Acceptance criteria:** for a Packeta guest with products 24.90 and fee 3.50: 201 and
status `payment.amount === 28.4`; the rendered QR decodes (pixel-compared against an
independent encode, UC-GP-011) to amount 28.4 and the unchanged reference; g-confirm shows
„Doručenie Packetou 3.50“ and „28,40 EUR“; the host card shows 28,40 with the breakdown;
`/unpaid` row `amount === 28.4`, `totals.total` includes it; `GET /api/guest-links/cycle/:id`
`totals.total` equals the product sum only.

---

## UC-GP-005 Edit — switching pickup ↔ Packeta, fee re-read, paid freeze (Guest)

**Goal:** the shared `handleStatusEdit` (both URL forms, 14 §UC-GR-001) accepts the
delivery block under the friend rules (R4.5), additively.

**Body (additive to `{ items }`):** `use_parcel_delivery?`, `packeta_address?`,
`guest_email?` (the one identity field with a write-once exception, resolved conflict 2).

**Business rules (in this order, after the shipped 410 / 409 `closed` / 409 `cancelled` /
400 non-array-`items` gates):**

1. **Literal `items: []` ⇒ cancel** (unchanged, UC-GP-006 zeroes the fee). Delivery fields
   in a cancel body are **ignored** — never validated, never written (the destructive
   action is the whole request's meaning).
2. **Non-empty `items` on a paid sub-order ⇒ 409 `reason:'paid'`** (shipped). Because the
   delivery block is only applied alongside a non-empty `items`, **a paid sub-order's
   delivery method cannot change** (D2). The message gains nothing — the shipped string
   already says „Zmenu vyriešte so správcom“.
3. **Delivery block:**
   - `use_parcel_delivery` **absent or `null`** ⇒ both columns untouched (API-additive,
     resolved conflict 4).
   - `false` ⇒ `delivery_fee = 0`, `packeta_address = NULL`.
   - `true` ⇒ `cycle.parcel_enabled` must be truthy (else 400, the UC-GP-002 string);
     `packeta_address` validated exactly as UC-GP-002 (string, non-blank, ≤ 160);
     **e-mail**: `order.guest_email` non-null, OR the body's `guest_email` is a string
     passing `EMAIL_SHAPE` and ≤ 160 — then it is **stored once** (`UPDATE … SET guest_email
     = ? WHERE id = ? AND guest_email IS NULL` — the predicate is the write-once guard; a
     body `guest_email` while one already exists is **ignored**, never an error, never a
     write). Missing on both sides ⇒ 400 `'Pri doručení Packetou zadajte e-mail'`.
     Then `delivery_fee = roundMoney(cycle.parcel_fee || 0)` **re-read inside the write
     transaction**, `packeta_address = <trimmed>`.
   - any other type ⇒ 400 `'Neplatný spôsob prevzatia'`.
4. The write transaction (`guest.js:983-1030`) re-reads cycle status and `paid` as today;
   the two delivery columns are written in the SAME `UPDATE guest_orders SET total = ?,
   status = 'submitted', delivery_fee = ?, packeta_address = ? WHERE id = ?` (literal
   columns, never a spread body — CLAUDE.md).
5. **Parcel disabled after the guest chose Packeta** (friend §Edge Cases mirrored): the
   stored fee + address survive untouched until the guest next saves; a save with `true`
   400s; the UI (UC-GP-007) hides the Packeta option and sends `false`, which clears both.
   Admin-side, the same state is corrected by UC-GP-009.
6. **Fee changed after submit:** stored fee untouched; the next save carrying `true`
   picks up the new fee (friend rule). The UI shows `cycle.parcel_fee` from `statusPayload`
   so the guest sees the amount they will be charged before saving.
7. Stock check unchanged (items only); the fee never enters stock, kg or pricing.
8. Response: `statusPayload` (fee-inclusive `payment.amount`, the two `order` columns).

**Acceptance criteria:** via_host → Packeta with a body e-mail on an e-mail-less order
stores the e-mail once (a second PUT with a different e-mail leaves it unchanged, 200);
Packeta → `false` zeroes fee and NULLs address (row read back); `true` while parcels are
off ⇒ 400 and the row is unchanged; a paid Packeta order refuses `items` + `false` with
409 `paid` and keeps its fee; admin raises `parcel_fee` 3.50 → 4.00, a re-save with `true`
stores 4.00, a PUT without delivery keys keeps 3.50.

---

## UC-GP-006 Cancel zeroes the fee — the one soft-cancel statement, and the refund row (system, Admin)

> ⚠ **Amended by PO decision 2026-09-19** (see §PO decisions at the end of this file): refund queue amount for a paid cancelled Packeta sub-order = items + fee (what was paid), not items only.

**Goal:** R4.7 — every cancel door zeroes `delivery_fee`; the record (address) survives.

**Business rules:**

- `helpers/guest-orders.js` `softCancelGuestOrder(id)` — THE one home with three doors
  (guest `items: []`, host `DELETE /api/guest-orders/:id`, admin `POST
  /api/guest-orders/:id/cancel`) — becomes
  `UPDATE guest_orders SET status = 'cancelled', total = 0, delivery_fee = 0 WHERE id = ?
  AND COALESCE(status,'submitted') <> 'cancelled'`. **Three literal columns**;
  `packeta_address` is NOT cleared (the record — mirrors "item rows KEPT"); `paid`,
  `paid_at`, `delivered`, `delivered_at`, `guest_email` untouched by construction.
- No door gains or loses a gate: the host's DELETE keeps its 409 `paid`, the admin's cancel
  keeps its NO paid blockade (14 D4), the guest's keeps the literal-`[]` rule.
- **Refund queue** (`/unpaid` `refunds`): a `paid = 1 AND status = 'cancelled'` row whose
  `packeta_address` is set publishes `packeta: true` (UC-GP-004) and `delivery_fee: 0`; its
  `amount` is items-only (resolved conflict 1). The admin refund card (`CycleDetail.vue`
  ~:1920-1935) shows the red „Packeta“ badge and the line **„+ poplatok za doručenie
  Packetou (suma podľa objednávky)“** under the amount when `packeta`. `OPEN:` whether the
  refund `amount` must include the fee — would require NOT zeroing it (contradicts R4.7 and
  01-architecture) or a `delivery_fee_paid` column; default = this marker, admin refunds
  the fee by hand.
- Every consumer keeps filtering on status (stock, packing, aggregation, distribution,
  rewards) — a cancelled Packeta row with its address kept must never classify as a
  `packeta` party anywhere (module 16's `delivery.js` filters `status` before type;
  seam stated in UC-GP-010).
- **No `transactions` row** on any door (guests have no ledger; pinned before/after).

**Acceptance criteria:** each of the three doors on a paid Packeta sub-order leaves
`status='cancelled', total=0, delivery_fee=0, packeta_address=<kept>, paid=1` (row read
back); `/unpaid.refunds[0]` has `packeta: true`, `amount === items sum`; `MAX(transactions.id)`
unmoved across all three.

---

## UC-GP-007 Status page — Packeta state, point, edit mode (Guest)

**Goal:** `GuestOrderStatus.vue` (06 §UC-GX-006/007) shows the guest where the bag goes
and lets them switch while editable.

**Read view (all four states):**

1. Header `.sub` (06 §UC-GX-006 item 1): `via_host` ⇒ shipped **„Vaša objednávka ·
   organizuje a odovzdá {host}“**; Packeta ⇒ **„Vaša objednávka · organizuje {host} · doručí
   Packeta“**.
2. **Pills row:** paid pill unchanged. The **delivered pill is replaced** on a Packeta
   order by `span.statuspill.off` **„Doručí Packeta“** (`data-testid="status-packeta"`; no
   `status-delivered` testid on Packeta rows — the host's hand-over flag is meaningless
   for a bag the host never holds; module 17's timeline later tells the guest the stage).
   `isDelivered` is still read from the payload (server-owned) but not rendered.
3. **Items card:** after the item lines and before the divider, a line **„Doručenie
   Packetou“** ↔ `span.mono` fee (`data-testid="status-delivery-fee"`, only when fee > 0);
   „Celkom“ `status-total` shows `fmtEur(payment.amount)` (fee-inclusive; for a via_host
   order that equals `order.total`, so the shipped pins hold). Cancelled: fee line struck
   like the items and no total (shipped rule) — fee is 0 anyway.
4. **Point card** (new, `.card` padding 16, only when `packeta_address`): `span.field-lbl`
   **„Výdajné miesto Packeta“** + the address (`data-testid="status-packeta-address"`),
   `.sub` **„Packeta vám pošle informácie o zásielke na {guest_email}.“**.
5. Cancelled Packeta order: the point card still renders (the record), the banner is the
   shipped one.

**Edit mode (06 §UC-GX-007):**

6. Above the product grid, a `.card` hosting `GuestDeliveryChoice` (UC-GP-003 — same
   component, seeded from `order.packeta_address ? 'packeta' : 'via_host'` and the stored
   address) when `cycle.parcel_enabled`. When parcels are OFF but the order IS Packeta
   (edge case 5 of UC-GP-005): instead a `div.banner.warn.slim` **„Doručenie Packetou už
   nie je dostupné — objednávku vám odovzdá {host}.“** and the save sends
   `use_parcel_delivery: false`.
7. When switching to `packeta` on an order with `guest_email === null`, the card shows an
   **„E-mail *“** `input.inp` (`data-testid="edit-guest-email"`, `maxlength="160"`) with the
   Packeta help text — the one identity field the PUT may set once (UC-GP-005 rule 3).
   Never shown when an e-mail exists (identity stays frozen; no edit of an existing e-mail
   anywhere on this surface).
8. Cartbar `edit-total`: `Celkom: {fmtEur(cartTotal + (method === 'packeta' ?
   cycle.parcel_fee : 0))}`; a `.sub` line **„+ {fmtEur(parcel_fee)} doručenie Packetou“**
   when Packeta.
9. `saveEdit()` payload: `{ items, use_parcel_delivery, packeta_address?, guest_email? }`
   — the delivery block is **always sent in edit mode** (it is the guest's current choice;
   the fee is re-read on save, UC-GP-005 rule 3). Client validation mirrors UC-GP-003
   (point, e-mail) into the `edit-error` banner. The empty-cart funnel into the cancel
   confirm (06 §UC-GX-007) is unchanged — `confirmCancel()` still sends **`{ items: [] }`
   only**.
10. `loadSeq`, `[token, orderToken]` watch, `refreshStoredEntry`, `document.title` — all
    load-bearing shipped behaviour, untouched.

**Acceptance criteria:** Packeta order renders the „Doručí Packeta“ pill and no
`status-delivered`; point card shows the address; `status-total` shows the fee-inclusive
amount; edit → switch to via_host → save ⇒ payload `false`, page re-renders without the
point card and the total drops by the fee; a via_host order without e-mail switching to
Packeta shows the e-mail input and the saved order carries it.

---

## UC-GP-008 Host view — badge, point, „nemusíte nič odovzdávať“, no hand-over tick (Friend/host)

**Goal:** `GuestSubOrders.vue` (05 §UC-KG-003/004) tells the host which colleagues are
not theirs to hand over (R4.6).

**Business rules:**

1. On a live Packeta row, under the phone line (inside the name block, so the fold control
   and its `guest-items-toggle-{id}` are unchanged): `span.badge` in the danger colour
   **„Packeta“** (`data-testid="guest-packeta-{id}"`; if `friends-theme.css` has no red
   badge variant, style it in `<style scoped>` — never an ad-hoc theme edit), then
   `.sub` mono 12px the address, then `.sub` 12.5px **„Tento kolega dostane balík Packetou
   — nemusíte nič odovzdávať.“** (R4.6 copy, vy-form).
   ⚠ It is NOT inside `data-testid="sub-order-badges"` — that container's "exactly one
   badge" pin (`colleagues-panel.spec.js:341`) must keep holding.
2. **The hand-over checkbox (`guest-delivered-{id}`, 05 §UC-KG-004) is NOT rendered on a
   Packeta row** — there is nothing to hand over; `delivered` stays the host's flag
   elsewhere and this module writes it nowhere. `PATCH /api/guest-orders/:id/delivered`
   is unchanged server-side (a host ticking a Packeta row via API is harmless and not
   worth a new 409; recorded).
3. „Odstrániť“ (soft cancel, 05 §UC-KG-005) and „Kopírovať odkaz“ (14 §UC-GR-007) stay on
   Packeta rows — the host may still call off a colleague's order and resend the URL.
4. The `summary` emit's `pendingDelivery` (`GuestSubOrders.vue:202`, the amber badge
   count on the Kolegovia tab when locked) **excludes Packeta rows** — the host owes them
   no action.
5. Foot total per UC-GP-004 (fee-inclusive with breakdown). Cancelled Packeta row: the
   struck amount is `cancelledTotal()` (items) — the fee is not recomputed (resolved
   conflict 1); the badge still renders (the record).
6. Payload: nothing new beyond `GUEST_ORDER_FIELDS` (UC-GP-001); `totals` unchanged.

**Acceptance criteria:** a Packeta row shows the badge, address and sentence, has no
`guest-delivered-{id}`, and `sub-order-badges` still holds exactly one badge; a via_host
row is unchanged; with one Packeta and one via_host live sub-order on a locked cycle, the
tab badge reads 1.

---

## UC-GP-009 Admin — nested row, receivables, and the delivery correction `PATCH /api/guest-orders/:id/delivery` (Admin)

**Goal:** the admin sees the point + phone on every guest surface and can correct a
guest's delivery back to hand-over by the host — the guest counterpart of the friend
pickup PATCH (`orders.js:582-655`), through the same helper (R4.8).

**API — `PATCH /api/guest-orders/:id/delivery`** (`routes/guest-orders.js`, the MIXED
router: `requireAdmin` **per route**, never on the mount; joins `ADMIN_ENDPOINTS`):

- Body: **exactly** `{ method: 'via_host' }`. Anything else — `{}`, `true`, `[1]`,
  `{ method: 'packeta' }`, `{ method: 'via_host', packeta_address: '…' }` — ⇒ 400
  `'Neplatný spôsob prevzatia'`, `field: 'method'`, writes nothing (explicit intent — the
  `items: []` rule in its non-destructive form; the friend route's "exactly one of two"
  precedent). Setting a Packeta address FOR a guest is **not** a v1 capability (`OPEN:`
  below; the guest's own edit URL is the admin's recovery path via 14 §UC-GR-008's resend).
- 404 unknown id (uniform); 409 `reason:'cancelled'` on a cancelled row (the `delivered`
  PATCH precedent — the fee is already 0 there); **no cycle-open gate** (the correction is
  needed after lock); **no paid gate** (mirrors the friend route — behind a UI confirm that
  names the fee); an admin token only (`requireAdmin`; a host Bearer ⇒ 401 — the friend
  identity endpoints table in `api-security.spec.js` is the model).
- Write through **`helpers/pickup.js`** — new export `applyGuestDelivery(guestOrderRow,
  { method: 'via_host' })`: `UPDATE guest_orders SET packeta_address = NULL, delivery_fee
  = 0 WHERE id = ?`; returns `{ cleared_parcel, parcel_fee_removed }` exactly like
  `applyPickup`. ⚠ It writes NO `transactions` row and nothing else — ledger-neutral by
  construction (there is no guest ledger, so unlike the friend clearance there is not even
  a `total`-only argument to make; the e2e still reads `MAX(transactions.id)` back).
  `pickupTargetFor()` stays host-keyed and untouched — a guest is not a pickup party of the
  link.
- Response: the sub-order in the `loadSubOrder(id)` shape (the GSO-T5 mutation shape)
  **+ `cleared_parcel`, `parcel_fee_removed`**.

**Admin UI — orders tab nested row (`CycleDetail.vue:2224-2300`):**

- After the e-mail span: `Badge` **„Packeta“** (`border-red-400 text-red-600 bg-red-50`,
  `data-testid="guest-packeta-badge-{id}"`) + `text-xs text-muted-foreground` `📦 {address}`
  when `packeta_address`. Amount per UC-GP-004.
- Controls row (:2278-2300) gains, on a live Packeta row, a text button **„Zmeniť na
  odovzdanie cez {host}“** (`data-testid="guest-delivery-switch-{id}"`) → inline confirm
  (the `PickupLocationPicker` parcel-confirm pattern, `parcel-confirm` :264-280) **„Zruší sa
  doručenie Packetou a poplatok {formatPrice(delivery_fee)}. Ak hosť poplatok už uhradil,
  treba mu ho vrátiť.“** with **„Áno, zmeniť“** / **„Nie“** (`guest-delivery-confirm-{id}`).
  On success patch the row from the response (per-row pending keyed by `guest_orders.id`,
  the shipped `rowSeq` idiom; never a full reload per tap). ⚠ `PickupLocationPicker.vue`
  is NOT reused here — its props are `cycleId` + `friendId`, "never an order id"
  (CLAUDE.md); a guest is addressed by its own id.
- Receivables / refund cards (~:1880-1935): red „Packeta“ badge + address + phone on rows
  with `packeta`; the refund marker line per UC-GP-006.
- The „Hosťovské odkazy (všetci priatelia)“ fold renders no guest data — unchanged.

**Acceptance criteria:** the PATCH on a paid Packeta guest zeroes the fee and NULLs the
address (row read back), `paid` stays 1, `MAX(transactions.id)` unmoved; the five bad
bodies 400 with the row unchanged; a cancelled row 409s; a friend token 401s; the endpoint
is in `ADMIN_ENDPOINTS`; the UI confirm names the fee and the row re-renders without the
badge.

---

## UC-GP-010 Distribution and the packing gate — a Packeta guest is its own party (Admin; seam to module 16)

**Goal:** roadmap §11 — "A guest who chose Packeta is its own bag and its own party." The
bag is not inside the host's bag, so it must not gate the host's packing, must not inherit
the host's hand-over, and must print under **Packeta** with the guest's phone (R4.6).

**Payload contract — `GET /api/cycles/:id/distribution` (`cycles.js:521-620`), until module
16 replaces it with its `parties` shape, and as the rule 16's shape must honour:**

1. A live sub-order with `packeta_address IS NOT NULL` is **removed from its host's
   `guest_orders[]`** and emitted as its **own party row**:
   `{ kind: 'guest', key: 'guest:<guest_order_id>', id: null, guest_order_id, name:
   guest_name, host_friend_id, host_name, phone: guest_phone, email: guest_email, order_id:
   null, has_own_order: false, status: 'submitted', paid, total, delivery_fee,
   packeta_address, pickup_location_id: null, pickup_location_note: null,
   pickup_location_name: null, packed: <all items packed ? 1 : 0>, packed_at: null,
   balance: null, items: [<guest items with packed, the T7 label fields>], guest_orders: [] }`.
   Every existing party row gains `kind: 'friend'` and `key: 'friend:<id>'` (additive).
   ⚠ `Distribution.vue`'s `v-for` key becomes `party.key` — `guest_orders.id` and
   `friends.id` are independent sequences (the T7 `own:`/`guest:` collision lesson).
2. A host with **no own submitted order** appears as the pickup party **only if they have
   ≥ 1 live `via_host` sub-order**; a host whose only live sub-orders are Packeta is absent
   (nothing to collect — the T7 "only cancelled bags ⇒ absent" rule extended).
3. Sort: friend/host parties by name as today; Packeta guest parties **after** them, by
   name (the print sheet groups Packeta together; module 16's board puts them in the
   Packeta group).

**Packing gate — `helpers/packing.js` `packingItemStats(hostFriendId, cycleId)`** (the ONE
home for the packed gate's counting, GSO-T7): the guest half's predicate gains
**`AND gord.packeta_address IS NULL`** — a Packeta bag never gates the host's „Zabaliť“.
The Packeta guest's own "packed" state is **derived** (all its `guest_order_items.packed`
= 1; `guest_orders` has no whole-order flag and none is added) — module 16's
`handed_over_at` for a guest party MUST use that derivation as its 409 `not_packed` test
(seam). ⚠ `PATCH /api/guest-order-items/:id/packed` auto-unpacks the HOST's order when a
guest item is unticked on a packed host order (T7); for an item of a **Packeta** sub-order
it must **not** touch the host's order (the bag is not theirs) — the auto-unpack branch
checks the parent's `packeta_address IS NULL`.

**`Distribution.vue` (today's flat list; module 16b redesigns it — whichever lands second
adapts to this contract):**

- A `kind: 'guest'` party renders like the synthetic no-own-order host row (no „Zabaliť“
  button, violet-free), with `Badge` **„Hosť • cez {host_name}“** (violet, the T6
  vocabulary), the red **„Packeta“** badge (on screen AND `print:inline-flex`), `📦
  {packeta_address}` and the phone `mono`, the amount per UC-GP-004, and its items with
  `guest:` pending keys. No `PickupLocationPicker` (host-keyed) — the correction is
  UC-GP-009's control, offered here too as the same inline button + confirm (one
  component `GuestDeliverySwitch.vue`, consumed by CycleDetail and Distribution).
- The print sheet lists the party under the Packeta group with address + phone; folds
  stay `hidden print:flex`.

**Seams to module 16 (stated on both sides):**

- `helpers/delivery.js` classifies a sub-order with `packeta_address` as type `packeta`,
  target = address + `guest_phone`; everything else under a host is `via_host`. Status is
  filtered BEFORE classification (a cancelled row keeps its address — UC-GP-006).
- **Host hand-over inheritance stamps only `via_host` sub-orders** (01-architecture says
  "every non-cancelled guest sub-order of that host" — module 16 must add `AND
  packeta_address IS NULL`; a Packeta guest is handed over on its own row).
- Module 21's „Odovzdané Packete“ template targets Packeta guests by their own
  `guest_phone` (R5.2 — "unless the guest chose Packeta → include them").
- Rewards (GSO-T9) are **unchanged**: a Packeta guest's kilos still credit the host
  (roadmap §4 "Rewards for the host still accrue"); `guestCycleItems()` is untouched.

**Acceptance criteria:** with host H (own order) + guest A (via_host) + guest B (Packeta):
the payload has H with `guest_orders = [A]` and a separate `kind:'guest'` party for B; all
of H's own + A's items ticked ⇒ `PATCH /api/orders/:hId/packed` 200 while B's items are
unticked; unticking B's item after H is packed leaves `orders.packed = 1`; a host with only
B (no own order) is not listed; the print media lists B under Packeta with address + phone.

---

## UC-GP-011 Verification — e2e obligations (system)

**Goal:** what the new spec file pins and the exact sanctioned edits to shipped specs
(case (a) of the e2e-immutability rule, 03 §UC-FL-013 — retargets cite the mandating UC).
Fixtures per test, never a shared `beforeAll` (the GSO-T8 worker-restart lesson); money
paths **read the row back** through `withDb`; ledger pins use the FUP-T17
`MAX(transactions.id)` before/after idiom (`guest-admin-view.spec.js:50-113`).

**1. New `e2e/tests/guest-packeta.spec.js`:**

- **Submit contract (UC-GP-002):** default submit ⇒ `delivery_fee 0`, `packeta_address
  NULL`, 201 body identical to a parcel-off cycle's except the new fields; Packeta submit
  ⇒ `delivery_fee === roundMoney(parcel_fee)`, trimmed address, `total` = product sum,
  `payment.amount === total + fee`; the 400 matrix (parcel off; address missing / blank /
  number / object / 161 chars; e-mail missing / `'x'`; `use_parcel_delivery` `'true'` /
  `1` / `[true]`) each with `field` and `COUNT(*)` unmoved; `{}`/`true`/`[1]`/`'abc'` bodies
  never 500; the `guestWriteLimiter` still covers the route (no new bucket asserted by
  reading `middleware/rate-limit.js` export count = 5 off disk).
- **Amount (UC-GP-004):** status `payment.amount`; g-confirm `confirm-delivery-fee` +
  sum; status page `status-delivery-fee` + `status-total`; host card total + breakdown;
  admin nested amount; `/unpaid` `amount`, `totals.total`; guest-links `totals.total`
  product-only.
- **⚠ Pixel QR for a Packeta order:** reuse `readModules()` / `independentQr()` from
  `guest-payment-modal.spec.js` — **extracted to `e2e/qr-helpers.js`** (sanctioned edit
  below; no assertion change there) — and assert the rendered modules equal the independent
  encode for `amount = total + fee`, the decoded `paymentNote` = `guestPaymentReference()`
  output (unchanged), `beneficiary.name = 'Gorifi'`.
- **Edit (UC-GP-005):** every row in that UC's acceptance list; identity freeze restated
  (a body `guest_name` is still ignored); the write-once e-mail (second PUT with a
  different e-mail ⇒ 200, unchanged row).
- **Cancel (UC-GP-006):** three doors on a paid Packeta row ⇒ fee 0, address kept, refund
  row `packeta: true`, `amount` items-only.
- **Ledger:** `MAX(transactions.id)` unmoved across submit, edit, admin paid toggle, admin
  delivery PATCH and each cancel door (one test, six checkpoints).
- **Admin PATCH (UC-GP-009):** the acceptance list; friend token 401; anonymous 401.
- **Host (UC-GP-008):** payload carries the columns; UI badge/address/sentence; no
  `guest-delivered-{id}` on the Packeta row; `sub-order-badges` count 1; tab badge count
  excludes Packeta when locked; „Odstrániť“ and „Kopírovať odkaz“ still present.
- **Distribution + gate (UC-GP-010):** the acceptance list, plus print media (`emulateMedia`)
  shows address + phone under Packeta.
- **Guest UI (UC-GP-003/007):** parcel-off cycle ⇒ no delivery controls in the checkout
  DOM (non-vacuity gate: the modal IS open); parcel-on ⇒ default via_host, Packeta reveals
  the field with `maxlength="160"` and flips the e-mail label; the three client messages
  fire without a request (`page.waitForRequest` negative with a timeout gate); status
  Packeta pill + point card; edit switch both ways.
- **Mail (UC-GP-004, the 14 §UC-GR-010 item 10 harness — `e2e/mailgun-harness.js`,
  self-skipping):** a Packeta submit ⇒ ONE stub request whose `text` carries
  `Doručenie Packetou`, the fee-inclusive `Spolu`/`Suma`, the address and the canonical URL;
  a via_host submit's mail is byte-identical to today's (no fee line).

**2. Sanctioned edits to shipped specs (grep `e2e/` before assuming this list is complete —
the module-14 lesson):**

| File | Edit | Why |
|---|---|---|
| `api-security.spec.js` | `ADMIN_ENDPOINTS` **+= `PATCH /api/guest-orders/1/delivery`** | standing CLAUDE.md rule (UC-GP-009). ⚠ No public guest route is new — nothing joins the zero-external-requests sweep. |
| `guest-payment-modal.spec.js` | extract `readModules` + `independentQr` into `e2e/qr-helpers.js` and import them; **no assertion changes** | UC-GP-011 item 1 reuses the pixel-QR approach (01-architecture gate note) |
| `guest-order-recovery.spec.js` | mail describe **+= constants** `MAIL_DELIVERY_LABEL`, `MAIL_PACKETA_LABEL` (additive, the two-place-edit convention of 14 §OPEN); existing constants untouched | UC-GP-004 mail rows |
| `guest-distribution.spec.js` | expected **NO change** — every guest there is via_host; if the `distribution[]` key rename to `party.key` breaks a locator, retarget the locator only | UC-GP-010 additive contract |
| `colleagues-panel.spec.js`, `guest-host-view.spec.js`, `guest-status.spec.js`, `guest-order.spec.js`, `guest-admin-view.spec.js` | expected **NO change** — all their fixtures are via_host and every payload change is additive | — |

**3. Procedure:** `node --check` on every changed backend file (no unit runner — do not add
one); targeted files first (`guest-packeta`, `api-security`, `guest-payment-modal`,
`guest-order-recovery` mail describe, `guest-distribution`, `guest-host-view`,
`guest-status`, `guest-order`, `guest-admin-view`, `colleagues-panel`, `order-pickup-edit`),
full suite only at the module milestone (memory: e2e gate frequency), `--workers=1`, all
five `RATE_LIMIT_*_MAX` raised, output to a file, `echo "EXIT: $?"`.

---

## Deploy continuity (module-level)

- **Mid-open-cycle deployable.** The ALTERs add `delivery_fee 0` / `packeta_address NULL`
  to every existing sub-order — all of them are, correctly, via_host. No token, URL, or
  `localStorage` entry changes. The shipped checkout/edit payloads (no delivery keys) keep
  working byte-identically (UC-GP-002 rule "absent ⇒ via_host", UC-GP-005 rule "absent ⇒
  untouched").
- Backend restart required (migrations); frontend rsync as always; no `.env` change; no
  nginx/CSP change (no external asset — the Packeta widget is explicitly out).
- A cycle with `parcel_enabled = 0` (every cycle until the admin enables it) shows guests
  **nothing new** on the ordering page except the two extra `cycle` fields in the payload.

---

## Decisions (module-level, recorded)

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | Submit/edit body mirrors the friend route: `use_parcel_delivery` (strict boolean `true`) + `packeta_address`; absent ⇒ via_host. | A `delivery_method: 'packeta'|'via_host'` enum — two vocabularies for one concept across friend and guest routes drift; the boolean is already what `orders.js` accepts. Truthy coercion (the friend route's) — a public write gets the strict type gate instead (`[true]` is the trap). |
| D2 | A paid sub-order's delivery method is frozen with its items; cancel stays open. | Allowing the switch on a paid order — it changes the amount owed with nowhere to record the difference (the GSO-T6 class). |
| D3 | `guest_email` may be **set once** on the edit PUT when NULL and Packeta is chosen; never overwritten. | 409 the switch (a dead end the guest cannot resolve alone); allowing e-mail edits generally (reopens the GSO-T4 rewrite risk). `OPEN:` PO sign-off. |
| D4 | Cancel zeroes `delivery_fee`, keeps `packeta_address`; the refund row carries `packeta: true`, `amount` items-only. | Keeping the fee on cancel (contradicts R4.7 + 01-architecture); clearing the address (destroys the record the admin needs to refund the fee). |
| D5 | Admin correction is `PATCH /api/guest-orders/:id/delivery` `{ method: 'via_host' }` via a new `pickup.js` export; setting a Packeta address for a guest is not a v1 admin capability. | Reusing the host-keyed pickup PATCH / `PickupLocationPicker` (they address a party by `cycleId`+`friendId`, "never an order id"); a free-form `packeta_address` write by the admin (not asked; the guest's own edit URL, resendable per module 14, is the recovery path). |
| D6 | A Packeta guest is its own distribution party (`kind:'guest'`), excluded from the host's `guest_orders[]`, the host's packing gate and the host's hand-over inheritance. | Leaving it nested under the host — the host's „Zabaliť“ would wait on a bag they never touch, and 16's inheritance would stamp a bag that was not handed to the host. |
| D7 | The host's `delivered` tick is hidden on Packeta rows in the UI; the endpoint is unchanged. | A server 409 — a harmless write is not worth a new refusal path; the flag stays host-owned. |
| D8 | `totals` on the host view stays product-only and unchanged. | Folding fees in — the shape is GSO-T5-pinned and it is a context figure, not a charge. |
| D9 | `validateIdentity()` is untouched; the Packeta e-mail rule is a separate check after it. | Extending the shared function — it is also the invite CTA's validator (GSO-T10) and a money-path regression net. |
| D10 | New guest-facing strings say „objednávka“, never „cyklus“. | Copying the friend route's error string verbatim. |

---

## Supersedes / amends (for sibling specs and CLAUDE.md when this lands)

- **05 §UC-KG-003 / §UC-KG-004** — the card gains the Packeta block; the hand-over checkbox
  is conditional (absent on Packeta rows). The UC-KG-007 selector table stays valid;
  `guest-delivered-{id}` is now "live via_host rows only".
- **06 §UC-GX-003 / 004 / 006 / 007** — checkout gains the delivery choice + conditional
  e-mail label; g-confirm and g-status gain the fee line, the point card and the Packeta
  pill; edit mode gains the delivery card and the write-once e-mail input.
- **14 §UC-GR-011** — the confirmation mail gains two additive kv rows; D10/D11 there are
  unchanged.
- **CLAUDE.md §Money & data** — "Guest cancel = `status='cancelled'`, `total=0`, item rows
  KEPT" becomes "…, `total=0`, **`delivery_fee=0`**, item rows and `packeta_address` KEPT";
  "`helpers/pickup.js` (which row stores a party's pickup)" gains "+ the guest Packeta
  clearance (`applyGuestDelivery`)"; the guest-bounds line gains "point 160".
- **01-architecture §Roadmap additions** — the hand-over inheritance sentence for module 16
  must read "every non-cancelled **via_host** guest sub-order" (UC-GP-010 seam).
- **`docs/learnings/02-guest-shared-orders.md`** — append the module's learnings (the
  CLAUDE.md-split rule); GSO-T7's "all own+guest items packed" bullet gains "via_host
  guests only".

---

## Accepted risks / follow-ups (recorded, not silently implemented)

- **The fee of a cancelled paid Packeta order is not in the refund `amount`** (D4) — the
  admin refunds it by hand from the marker. Resolve via the OPEN below if it bites.
- **A URL holder can add an e-mail to an e-mail-less order once** (D3) — gains Packeta
  notifications for someone else's bag, nothing more; same class as the accepted
  "host/admin holding `order_token` can act as the guest" risk in module 14.
- **No e-mail shape gate on via_host submits** (today's behaviour) — only Packeta requires
  a plausible address; tightening the optional field is not this module's ask.
- **The admin cannot set a Packeta point for a guest** (D5) — recovery is the guest's own
  edit URL, resent via 14 §UC-GR-007/008.
- **A Packeta guest's `delivered` flag can still be set via API by the host** (D7) — no UI
  path; harmless.
- **Module 16/20 ordering:** §18 puts 20 after 16a (backend) but not necessarily after 16b
  (board UI). If 20 lands first, `Distribution.vue`'s flat list renders the `kind:'guest'`
  party per UC-GP-010; if 16b lands first, its board consumes the same contract. Whichever
  is second adapts; the payload contract in UC-GP-010 is the fixed seam.

---

## OPEN items

- `OPEN:` PO sign-off on ALL drafted Slovak strings (marked draft; hoist each into the
  spec file as constants per the module-14 two-place-edit convention): the radio labels
  „Prevezmem od {host}“ / „Poslať Packetou (+{fee})“ (R4.1 verbatim — likely final), the
  point field label/placeholder/help, „E-mail *“ + „Packeta vám naň pošle informácie o
  zásielke.“, the subtitle „balík vám doručí Packeta.“, the three client messages, the
  hero badge „Packeta +{fee}“, the server 400 strings (`'Neplatný spôsob prevzatia'`,
  `'Zadajte výdajné miesto Packety'`, `'Výdajné miesto je príliš dlhé (najviac 160 znakov)'`,
  `'Pri doručení Packetou zadajte e-mail'`, `'Doručenie Packetou nie je pre túto objednávku
  dostupné'` — ⚠ backend strings, a frontend-only sign-off grep misses them), the status
  pill „Doručí Packeta“, „Výdajné miesto Packeta“, the point-card `.sub`, the edit-mode
  warn banner, the host sentence „Tento kolega dostane balík Packetou — nemusíte nič
  odovzdávať.“ (R4.6 paraphrase), the admin switch button + confirm, the refund marker
  line, the mail labels `Doručenie Packetou` / `Výdajné miesto`.
- `OPEN:` **Refund of the fee** (resolved conflict 1 / D4): should a cancelled paid Packeta
  sub-order's refund `amount` include the fee? Default = no (marker only). Yes would need a
  column that survives cancel (contradicts R4.7's "zeroes `delivery_fee` too" — the PO
  would have to amend that line).
- `OPEN:` **D3 (write-once e-mail on edit)** — confirm, or choose the 409 alternative.
- `OPEN:` **Admin sets a Packeta point for a guest** (D5) — not in v1; confirm it can wait
  (the guest can do it via their edit URL while the cycle is open; after lock the admin
  has today no way to make a guest Packeta — is that acceptable for the first round?).
- `OPEN:` Hero badge — show „Packeta +{fee}“ on the ordering page at all, or leave the
  fee to the checkout modal only? Default = show (portal2.jsx:160 shows the friend the
  same badge).
- `OPEN:` Should the guest see any Packeta-specific line in the **cartbar** (UC-GP-003 rule
  3 keeps the cartbar product-only and states the amount in the subtitle)? Default = no
  cartbar change.

---

## Deliverables summary (files this module creates/edits)

**Backend:** `db/schema.js` (2 columns, CREATE + ALTER); `helpers/guest-orders.js`
(`GUEST_ORDER_FIELDS` + 2, `softCancelGuestOrder` + `delivery_fee = 0`); `helpers/pickup.js`
(`applyGuestDelivery`); `helpers/packing.js` (`packeta_address IS NULL` in the guest half);
`helpers/mailer.js` (export `EMAIL_SHAPE`); `routes/guest.js` (listing + `statusPayload`
cycle flags; submit delivery block; edit delivery block + write-once e-mail; column lists;
`payment.amount`; mail rows); `routes/guest-orders.js` (`PATCH /:id/delivery`; `/unpaid`
fields + `amount`); `routes/guest-order-items.js` (no auto-unpack of the host for a Packeta
parent); `routes/cycles.js` (`/distribution` Packeta guest parties, `kind`/`key`).
**Frontend:** new `components/GuestDeliveryChoice.vue`, new `components/GuestDeliverySwitch.vue`
(admin), `lib/email-shape.js` (the mirrored regex); `views/GuestOrder.vue`,
`views/GuestOrderStatus.vue`, `components/GuestSubOrders.vue`, `views/CycleDetail.vue`,
`views/Distribution.vue`, `api.js` (`switchGuestDelivery(id)`).
**e2e:** new `tests/guest-packeta.spec.js`, new `qr-helpers.js`; edits per UC-GP-011 §2.
**Docs on landing:** CLAUDE.md one-liners + `docs/learnings/02-guest-shared-orders.md`
write-up (§Supersedes list).

## PO decisions 2026-09-19 — OPEN items resolved

> Recorded by the orchestrator from the PO walkthrough. Each line resolves the `OPEN:` of the same name above; where a default was overturned the affected UC carries an amendment note.

- **Refund of the fee** = **items + fee** (default OVERTURNED). ⚠ Amends UC-GP-006: a cancelled PAID Packeta sub-order enters the refund queue with `amount = total_paid + delivery_fee` (the amount actually paid); the `packeta:true` marker stays for the admin's information. `delivery_fee` on the row is still zeroed by cancel — the refund amount is computed from the paid snapshot, not from the live column.
- **Write-once e-mail on edit** = confirmed (set once if NULL, never overwrite; 409 alternative rejected).
- **Admin sets a guest's Packeta point** = not in v1.
- **Hero badge „Packeta +{fee}“** = YES. **Cartbar** = product-only; fee appears at checkout, confirmation and status.
- **Slovak strings** = staging sign-off.
- **Orchestrator clarification 2026-09-19 (refund mechanics):** cancel still zeroes the live `delivery_fee`, so the PO's „items + fee“ refund needs a value that survives cancel: add `guest_orders.delivery_fee_paid REAL` (CREATE + ALTER, lands with UC-GP-001's schema row), written ONLY by the admin paid toggle (`paid=1` copies `delivery_fee`, `paid=0` sets NULL). Refund `amount = itemsAmount(row) + (delivery_fee_paid || 0)`; the `packeta:true` marker stays. The UC-GP-006 / D4 / e2e „items-only“ wording is SUPERSEDED by this line.
