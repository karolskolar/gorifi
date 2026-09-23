# 12 — Packeta delivery for guests (module 20)

Per-task lessons for `docs/specification/20-guest-packeta.md`. Read this before touching
`guest_orders.delivery_fee` / `packeta_address` / `delivery_fee_paid`, the guest submit's
delivery block, `helpers/payment.js guestPaymentBlock().amount`, the guest confirmation mail's
fee/point rows, or `softCancelGuestOrder`. The guest-order machinery these build on
(sub-orders, `order_token`, the three cancel doors, the rate-limit buckets) is
`02-guest-shared-orders.md`; the payment block's one-home rule is `07-payment-links.md`; the
standing-token resolver the submit runs through is `11-guest-standing-link.md`.

---

## GP-T1 — schema, shared lists, cycle flags, the submit contract, the amount seam, the mail rows, the cancel (2026-09-23)

**What shipped.** Three `guest_orders` columns (CREATE + try/catch ALTER): `delivery_fee REAL
DEFAULT 0`, `packeta_address TEXT`, `delivery_fee_paid REAL` (the paid snapshot of the
orchestrator clarification). `GUEST_ORDER_FIELDS` += `delivery_fee`, `packeta_address`;
`routes/guest.js`'s two hand-picked order column lists (`loadOrder`,
`resolveGuestOrderByOrderToken`) += the same two; `findCycle` reads `parcel_enabled` /
`parcel_fee` and BOTH guest `cycle` blocks (listing + `statusPayload`) publish them through
one `publishedParcelFlags()`. The submit's delivery block (`validateDeliveryChoice()` + the
Packeta e-mail check), the fee re-read inside the insert transaction, `EMAIL_SHAPE` exported
from `helpers/mailer.js`, the amount seam (`roundMoney(total + delivery_fee)`), two mail rows,
the soft cancel (fee zeroed + snapshot frozen), and the admin paid toggle writing the snapshot. API-only — **no
screen changes in this row.** New spec `e2e/tests/guest-packeta.spec.js` (30 tests after review).

### 1. `packeta_address IS NOT NULL` is the marker — the fee never is

A fee of 0 is legal (the admin may run free parcels) and cancel zeroes the fee while KEEPING
the address. Every consumer that asks „is this a Packeta bag?" reads the address, and asks it
AFTER filtering on `status` (a cancelled row still has one). Pinned: a `parcel_fee = 0` submit
stores `delivery_fee 0` + the address.

### 2. `use_parcel_delivery` is a STRICT boolean on the public write

Absent / `null` / `false` ⇒ via_host (and a stray `packeta_address` beside them is NOT stored);
boolean `true` ⇒ Packeta; anything else — `'true'`, `'false'`, `1`, `0`, `[true]`, `{}` — ⇒ 400
`Neplatný spôsob prevzatia`. The friend route coerces truthily; the guest route is the app's
only unauthenticated write, so it does not (D1). Mutation-checked: a truthy gate reds the matrix.

### 3. Gate order, and why the e-mail rule is NOT in `validateIdentity()`

identity (shared `validateIdentity()`, UNCHANGED — it is also the invite CTA's and, since
GL-T3, the waitlist's validator) → `validateDeliveryChoice()` (flag type → parcel availability
→ point string/blank → point ≤ 160) → the Packeta e-mail check (missing ⇒ `Pri doručení
Packetou zadajte e-mail`, bad shape ⇒ the existing `Neplatný e-mail`) → pricing → empty cart →
stock. The e-mail check lives in the SUBMIT handler because GP-T2's edit gets its e-mail from a
different place (the stored row, or a write-once body value), so `validateDeliveryChoice()`
deliberately stops short of it — GP-T2 reuses it and supplies its own e-mail rule.
`EMAIL_SHAPE` is the mailer's regex, EXPORTED (one home): an address the checkout accepts is one
the confirmation mail will actually try.

### 4. The fee is re-read with the status INSIDE the transaction — and HTTP cannot tell

`SELECT status, parcel_fee FROM order_cycles` inside `db.transaction`. With synchronous
handlers under `instances: 1` no admin PATCH can interleave, so the resolver's earlier read and
the in-tx read always agree over HTTP: mutation M6 (read `cycle.parcel_fee` instead) stays
GREEN behaviourally — measured, 24/24. It is pinned in SOURCE instead (`guest-packeta.spec.js`
§8: the in-tx SELECT AND the `current.parcel_fee` charge line; the first version pinned only
the SELECT and M6 still passed, so a „re-read" that nothing used would have been green), the same
„a concurrency property no behavioural test can see" class as UC-GR-011's zero-`await` pin.

### 5. The amount seam moved exactly one line, and the via_host mail is byte-identical

`guestPaymentBlock().amount = roundMoney((order.total || 0) + (order.delivery_fee || 0))`. A
via_host row's total is already `roundMoney`ed at the write, so the figure is unchanged and
every PL-T2 byte-identity pin holds; 0.1 + 0.2 leaves as 0.3. The mail's `Spolu` and `Suma` now
quote `payment.amount` (equal to `order.total` for via_host). New rows: `Doručenie Packetou:
X.XX €` after the items and before `Spolu` (only when fee > 0), `Výdajné miesto: …` after
`Spolu` (whenever the address is set). `guest-order-recovery.spec.js` mirrors the two new
labels and asserts a via_host mail carries neither. ⚠ **The wire text is CRLF**: FormData
normalises a text field's `\n` to `\r\n`, so a line-exact mail assertion must split on
`/\r?\n/` — `split('\n')` leaves a `\r` the reporter renders as trailing blanks.

### 6. The paid snapshot — TWO writers, frozen at the FIRST of {paid, cancel}

~~`delivery_fee_paid` has ONE writer, the admin `PATCH /guest-orders/:id/paid` … paid=1 copies
`delivery_fee` — EXCEPT on a row that is already paid AND already has a snapshot (`CASE WHEN
paid = 1 AND delivery_fee_paid IS NOT NULL …`).~~ → **SUPERSEDED in the GP-T1 review by an
orchestrator decision (2026-09-23), PENDING PO confirmation.** The one-writer design had a
hole the review found: the guest pays 28.40, cancels (fee zeroed) BEFORE the admin matches the
transfer, the admin then ticks paid ⇒ snapshot copies the live 0 ⇒ refund 24.90. The payment
and the cancel arrive in either order; only the bank knows which came first.

**The rule now:** `delivery_fee_paid` = the fee part of the amount the guest was asked to pay,
frozen at the FIRST of {paid, cancel}. TWO writers, source-pinned (exactly one assignment in
`helpers/guest-orders.js`, exactly two in `routes/guest-orders.js`, none anywhere else):

| Writer | Statement |
|---|---|
| `softCancelGuestOrder` (all three doors) | `delivery_fee_paid = COALESCE(delivery_fee_paid, delivery_fee)` in the SAME `UPDATE` that sets `delivery_fee = 0` — SQLite evaluates every SET expression against the OLD row, so the right-hand `delivery_fee` is the pre-cancel fee |
| paid toggle, paid=1 | `COALESCE(delivery_fee_paid, delivery_fee)` — an existing snapshot ALWAYS wins |
| paid toggle, paid=0 | `CASE WHEN status = 'cancelled' THEN delivery_fee_paid ELSE NULL END` — on a live row nothing was paid (the next tick re-copies whatever the fee then is); on a cancelled row the fee is historical and a re-tick must restore it |

GP-T5's refund stays `itemsAmount + (paid ? delivery_fee_paid || 0 : 0)`. Pinned sequences
(row read back each step): pay → cancel ⇒ 28.40; cancel → pay ⇒ 28.40 (the review scenario);
live pay → unpay → pay ⇒ 3.5 / NULL / 3.5; cancel → pay → unpay → pay ⇒ 3.5 throughout,
refund 28.40; live pay → unpay → fee changes → pay ⇒ the NEW fee (then COALESCE holds it
against a later change); pay → fee changes → cancel ⇒ the cancel keeps the TICK's 3.5 (first wins).
Mutation-checked per writer: cancel writer removed (5 red), paid=1 plain copy (4), paid=0 always
NULL (2), paid=0 always kept (3), cancel overwriting instead of COALESCE (2 — only the source pin
until the pay→fee change→cancel test was added). An unpaid cancelled row now carries a snapshot too — harmless, the
refund formula gates on `paid`. ~~The live-fee step writes the column from the test (node:sqlite,
read-write) because no route can change a live fee until GP-T2 / GP-T5.~~ → every live-fee step
now goes through a real writer (GP-T2 §12, GP-T5 §33); `setLiveFee()` is deleted. ⚠ **When GP-T2 (the edit
PUT re-reading `parcel_fee`) and GP-T5 (the delivery PATCH zeroing it) land, re-point the
`setLiveFee()` steps at those real writers** — a fixture write proves the SQL, not the route (noted
in the GP-T2 row). → **GP-T2 DONE for the one UNPAID step (§12); the two PAID-row steps cannot be
reached by the edit (D2) and wait for GP-T5.** ⚠ GP-T5's refund queue must keep `paid = 1` in its QUERY, not only in the
formula: an unpaid cancelled row now carries a snapshot too.

Why here and not GP-T5 (whose row listed „paid toggle writes the snapshot", now struck): a
column that exists without its writers lets a Packeta payment recorded between the two deploys
lose its fee on a later cancel. GP-T5 only READS it. No back-fill: every pre-existing row is
via_host and NULL.

### 7. The three cancel doors — the spec's acceptance line is unreachable for ONE door

§UC-GP-006's acceptance says „each of the three doors on a PAID Packeta sub-order". The host
DELETE keeps its shipped 409 `paid` gate (the same UC says no door gains or loses a gate), so a
paid row cannot be cancelled by the host at all. The spec therefore pins: guest `items: []` +
admin cancel on a PAID row, host DELETE refused on the paid row (row read back untouched) and
then zeroing the fee on the same row once unpaid. All three leave `delivery_fee 0`, the
address KEPT, `guest_email` untouched, and the snapshot as it was.

### 8. Migration proof

Both ways: (a) in-spec, a throwaway boot on a temp DB pre-built with the GL-T7 shape and one
paid row ⇒ the three columns appear, the row reads `0 / NULL / NULL`, `total` untouched;
(b) on a copy of `e2e/fixtures/prod-template.sqlite` (which predates the module): columns
absent before boot, present after, all 20 existing rows `delivery_fee 0`, no address, no
snapshot.

### Seams left for the next rows

- GP-T2 (edit PUT): reuse `validateDeliveryChoice()`; add the write-once e-mail; the edit's
  `UPDATE … SET total = ?, status = 'submitted'` does not touch the delivery columns today, so an
  items-only PUT is already „both columns untouched".
- GP-T3 (UI): `cycle.parcel_enabled` / `parcel_fee` are on the listing; the frontend
  `lib/email-shape.js` must mirror `helpers/mailer.js EMAIL_SHAPE` byte for byte.
- GP-T5: `/unpaid` still does not carry the two columns (its mapping is hand-picked; the row
  owns it) — the refund amount reads `delivery_fee_paid`, which is NOT on `GUEST_ORDER_FIELDS`
  (select it there by name).

---

## GP-T2 — the edit PUT's delivery block, the write-once e-mail, the paid freeze (2026-09-23)

**What shipped.** `routes/guest.js handleStatusEdit` (the ONE handler both URL forms run —
`PUT /o/:orderToken` and the legacy `PUT /:token/orders/:orderToken`) gains the §UC-GP-005
delivery block and D3's write-once e-mail; a new `packetaEditEmail()` beside
`validateDeliveryChoice()`. API-only — no screen changes (GP-T4 owns the edit-mode UI).
`guest-packeta.spec.js` +11 tests (41 total), the ledger test extended, `setLiveFee()`
re-pointed where reachable.

### 9. Status code per case, and the gate ORDER

After the shipped 410 `inactive` / 409 `closed` / 409 `cancelled` / 400 non-array-`items`:

| Body | Answer |
|---|---|
| literal `items: []` + ANY delivery keys (even `'true'`, a number point, an object e-mail) | 200 cancel — delivery keys never validated, never written (rule 1) |
| non-empty `items` on a PAID row + any delivery keys (even an invalid flag) | 409 `paid` — the shipped gate runs FIRST, so the method is frozen with the items (D2) |
| flag absent / `null` | 200, `delivery_fee` + `packeta_address` UNTOUCHED (the shipped items-only statement, byte-identical); a stray `packeta_address` / `guest_email` is not written |
| `false` | 200, fee 0, point NULL (a stray point beside it is not stored) |
| `true`, parcels off | 400 `Doručenie Packetou nie je pre túto objednávku dostupné` · `use_parcel_delivery`, row unchanged (the stored Packeta state survives until a `false` save — rule 5) |
| `true`, bad point | 400 the submit's two point strings · `packeta_address` |
| `true`, row has NO e-mail, body e-mail missing/`null`/blank | 400 `Pri doručení Packetou zadajte e-mail` · `guest_email` |
| … body e-mail non-string / bad shape | 400 `Neplatný e-mail` · `guest_email` |
| … body e-mail > 160 | 400 `E-mail je príliš dlhý (najviac 160 znakov)` · `guest_email` |
| `true`, row HAS an e-mail | the body e-mail is IGNORED — even garbage (`{x:1}`) ⇒ 200 |
| any other flag type (`'true'`, `'false'`, `1`, `0`, `[true]`, `{}`) | 400 `Neplatný spôsob prevzatia` · `use_parcel_delivery` |

The delivery block runs BEFORE pricing (as on the submit): a bad flag beside a qty-101 line
answers the flag's 400. It is gated on `requestedCount > 0`, which is exactly „not a
cancel" (a non-empty list that prices to zero lines is its own 400 further down).

### 10. „Identity freeze" vs the write-once e-mail — ONE exception, two guards

The freeze (GSO-T4) still holds for `guest_name`/`guest_phone` on every PUT and for
`guest_email` on every PUT EXCEPT: `use_parcel_delivery === true` AND the stored row's
`guest_email IS NULL`. Only then is the body's e-mail validated, required, and written —
`UPDATE guest_orders SET guest_email = ? WHERE id = ? AND guest_email IS NULL`, a SEPARATE
statement in the same transaction after the delivery UPDATE. A second PUT with a different
e-mail ⇒ 200, row unchanged (the row now has one, so the body value is not even read).
Two guards: the handler's `!order.guest_email` pre-check (behavioural — it is what makes a
garbage body e-mail beside a stored one a 200, not a 400) and the SQL predicate (the D3 guard
the spec names; unreachable over HTTP under sync handlers, so SOURCE-pinned — mutation M3b,
predicate alone dropped, stays green behaviourally and reds only the pin). ⚠ A via_host row
whose checkout e-mail was unshaped (`'x'` — the submit shape-checks only Packeta) satisfies
the rule as-is: the spec says „`order.guest_email` non-null", and the freeze forbids
rewriting it. ⚠ **OPEN — PO question (review, 2026-09-23; also 20 §OPEN):** because of D3's
write-once rule the guest can NEVER correct such an address, so Packeta may get an
undeliverable e-mail. Options: (a) a stored e-mail counts only if it passes `EMAIL_SHAPE`
(an unshaped one is then treated as missing and the body's replaces it — a narrow widening of
the write-once exception, the predicate would become „NULL or unshaped"); (b) the admin can
correct a guest e-mail (a new admin write). Shipped as-is (neither) pending the answer.

### 11. The fee re-read and the one-statement write

`SELECT status, parcel_fee FROM order_cycles` inside the edit's `db.transaction` (was
`SELECT status`), and the charged line is byte-identical to the submit's
`const deliveryFee = delivery.packeta ? roundMoney(Number(current.parcel_fee) || 0) : 0;` —
GP-T1's §8 pin now matches TWO copies of it, the new GP-T2 pin slices `handleStatusEdit` and
asserts its own. Every PUT CARRYING `true` re-reads the fee, whether or not the method changed
(resolved conflict 4): pinned 3.50 → admin 4.00 → items-only PUT keeps 3.50 (amount 53.30),
`true` re-save stores 4.00; admin 3.456 ⇒ 3.46. Write:
`UPDATE guest_orders SET total = ?, status = 'submitted', delivery_fee = ?, packeta_address = ? WHERE id = ?`
— the spec's statement verbatim, `.run(total, deliveryFee, delivery.address, order.id)`. The
absent-flag path keeps the shipped two-column statement (both are pinned).
⚠ **GP-T1's „no write folds the fee into total" pin was REWRITTEN**: the old
`/total\s*=\s*[^;\n]*delivery_fee/` matched the spec-mandated statement itself
(`total = ?, status = …, delivery_fee`). A first narrowing to `[^,;\n]` was caught in review —
it missed folds with a comma INSIDE the expression (`ROUND(?, 2) + delivery_fee`,
`MAX(?, 0) + delivery_fee`). The pin now cuts only at a comma that STARTS THE NEXT
ASSIGNMENT: `/total\s*=\s*(?:(?!,\s*\w+\s*=)[^;\n])*delivery_fee/`, with three fold strings as
non-vacuity and the spec's own statement as a must-NOT-match (checked in node too).
`delivery_fee_paid` is untouched (the recursive two-writer walk still passes); no
`transactions` row (the watermark test now has two edit checkpoints with non-vacuity reads).

### 12. `setLiveFee()` re-pointed — and why two calls REMAIN

„live pay → unpay → fee changes → pay" now moves the fee through the real writer
(`repriceByEdit()`: admin PATCHes `parcel_fee`, the guest re-saves with `true`). The two other
calls change the fee of a PAID row, which the edit cannot do by construction (D2, 409 `paid`) —
each is now preceded by `paidEditRefused()`, which asserts the 409 and that nothing moved. They
stay fixture writes standing in for GP-T5's delivery PATCH (which zeroes a fee on any row) —
⚠ re-point THOSE two at it when GP-T5 lands.

### 13. Mutations (each run on a fresh server boot, `guest-packeta.spec.js` alone)

M1 absent/null treated as `false` (3 red) · M2 cancel validates delivery keys (1) · M3a body
e-mail taken beside a stored one (1) · M3b write-once predicate dropped (1 — source pin only,
see §10) · M3c both (2) · M4 fee from the resolver's `cycle` row (2 — source pins only, as
GP-T1's M6) · M5 `false` keeps the point (3) · M6 parcels-off check bypassed (2) · M7 e-mail
never stored (2) · M8 stored fee kept on `true` (3) · M9 the edit's e-mail rule skipped (2).

### Seams

- GP-T4 (status-page edit mode): send `use_parcel_delivery` ONLY from the delivery card —
  omitting it is the „untouched" contract, and the UI hides Packeta + sends `false` when
  `cycle.parcel_enabled` is 0 (rule 5). Show the e-mail input only when the loaded order has
  no `guest_email`; the server ignores it otherwise.
- GP-T5: re-point the two remaining `setLiveFee()` calls (§12).

---

## GP-T3 — the checkout delivery choice, the hero badge, g-confirm's fee + point, the GuestSteps seam (2026-09-23)

**What shipped.** `components/GuestDeliveryChoice.vue` (NEW — the ONE home of the radios +
point for checkout AND GP-T4's edit mode), `lib/email-shape.js` (NEW — the client mirror of
`helpers/mailer.js EMAIL_SHAPE`), `views/GuestOrder.vue` (the choice below Mobil, the e-mail
label flip + help, the subtitle amount + tail, the payload keys, the three client messages,
the reset on open, the fourth hero badge, g-confirm's fee line + point, `stepsPacketa` on
all three `GuestSteps` mounts), `CartLineList.vue` (extras may carry a `testid` — additive),
`e2e/helpers/qr-pixels.js` (+ `independentQr`). Spec: `guest-packeta.spec.js` +12 tests
(53 total). No server change.

### 14. The component owns PRESENTATION, the caller owns the PAYLOAD

The checkout sends the delivery keys ONLY for Packeta (§UC-GP-003 item 5 — a via_host
payload is byte-identical to the shipped one); GP-T4's edit PUT sends them ALWAYS
(§UC-GP-007 item 9 — omitting them there means „untouched"). Two contracts, one
component — so `GuestDeliveryChoice` exposes two v-models (`modelValue`
`'via_host'|'packeta'`, `packetaAddress`) and nothing else: no emit of a payload, no
validation, no error banner (each caller renders its own). ⚠ The caller guards with
`isPacketa = parcelEnabled && method === 'packeta'`, never the raw ref: a stale
`'packeta'` must never reach a payload or a label on a round that does not offer it.
Pinned: choose Packeta → type a point → switch back → submit ⇒ keys exactly
`guest_name, guest_phone, items`.

### 15. „Renders nothing when parcels are off" is the whole byte-identity contract

`<div v-if="parcelEnabled">` at the component root. A parcel-off modal's `.m-body`
element children are exactly `div:guest-name, div:guest-phone, div:guest-email` (pinned by
name, plus no radio, no `.field-help`, no „Spôsob prevzatia", the shipped label and
subtitle). A `<!--v-if-->` comment node is the only trace — no shipped pin reads comment
nodes. The subtitle's two tails are sibling `<template>`s on ONE line so the via_host text
stays the shipped string (the condense trap: a newline between them would eat the space).

### 16. One fee, one format: `EUR` on the radio AND the hero badge (orchestrator decision)

§UC-GP-003 writes the radio's fee as `(+{fmtEur(parcelFee)})` AND says „`€` because a fee is
a line, not a total" — `fmtEur` returns `EUR`, so the two halves contradict. ~~The first cut
followed the prose and rendered `(+3.50 €)`.~~ → **ORCHESTRATOR DECISION (GP-T3 review):
`(+3.50 EUR)` via `fmtEur`** — it is the spec's own formula, it matches FriendOrder's
identical radio (`FriendOrder.vue:2685`, „(+X.XX EUR)"), and it matches the hero badge
(`Packeta +3.50 EUR`, `portal2.jsx:160`'s `eur()` and the portal explainer's parcel badge):
one fee, one format on the page. The `€`-on-lines rule stays for `CartLineList` lines —
g-confirm's `Doručenie Packetou  3.50 €` is such a line. PO sign-off on staging covers both.

### 17. The hero badge collides with NO shipped pin — the count is fixture-driven

`guest-order-shell.spec.js:207` (`hero.locator('.badge')` = 3) and every GL-T4/T5 hero pin
build their rounds WITHOUT `parcel_enabled` (default 0), so the fourth badge never renders
there; the pre-open hero is a different card and gets no badge. No retarget needed. The new
test pins count 4 on a parcel round with the shipped three unchanged in order.

### 18. The `GuestSteps` seam — one computed, three mounts, and why the pre-open card stays off

GL-T4's source pin „GuestOrder.vue does not pass packeta" was the sanctioned retarget: it now
asserts all three mounts bind `:packeta="stepsPacketa"`. `stepsPacketa = !preopen &&
parcelEnabled`. ⚠ The pre-open payload (19 §UC-GL-003) carries NO cycle — there is no open
round through this token, so there is no parcel flag to read, and the clause stays off on
that card. Turning it on there needs a server addition (e.g. the next planned round's
`parcel_enabled` on `next`), which is a public-contract change this row does not make —
PO/orchestrator question. Binding the SAME computed on the pre-open mount means only the
computed changes if that flag ever lands.

### 19. The shared QR helper already existed — `e2e/qr-helpers.js` was NOT created

20 §UC-GP-011 names a new `e2e/qr-helpers.js`; it was written before PL-T4 created
`e2e/helpers/qr-pixels.js` (`readQrModules` + `qrMatrix`), whose header even invites the next
sanction-holder to retro-fit `guest-payment-modal.spec.js`. A second QR module beside it would
be the fork that file exists to stop. So: `independentQr()` moved verbatim into
`qr-pixels.js` (it now imports the frontend's `bysquare` + `qrcode`, the same cross-tree
import every QR spec makes); `guest-payment-modal.spec.js` imports
`readQrModules as readModules` + `independentQr` — its in-file `readModules` was
byte-identical to `readQrModules` at the default selector. Zero assertion lines changed
(`git diff | grep '^[-+]' | grep -c 'expect('` = 0). `money-rounding.spec.js`'s copy (a
different signature) is still untouched — no sanction covers it.

### 20. The pixel-QR for total + fee needs a NEGATIVE control

The rendered code is compared bit for bit against `independentQr(28.4, …)`, decoded to
amount 28.4 with the unchanged reference `G{id} / {name} / {cycle}` — and ALSO asserted
unequal to the product-only encode (24.9). Without that control a component that ignored the
fee would still pass whenever both sides were fed the same number.

### 21. g-confirm's fee line is a `CartLineList` EXTRA, not new markup

`deliveryExtras(order.delivery_fee)` (`lib/order-lines.js`, the friend cart's own mapping)
feeds `:extras`; each extra may now carry `testid` (`confirm-delivery-fee`), rendered as
`:data-testid="extra.testid || null"` so every shipped caller's `<li>` is unchanged. It
renders `Doručenie Packetou` ↔ `3.50 €` after the items and only when the SERVER's stored
fee is > 0; the sum is `payment.amount`. The point sits below the card as `.sub`
„Balík vám doručí Packeta: {point}" with the point in a `data-user-copy` span.

### 22. Test traps met

- `locator('label.radiorow', { has: dialog.getByTestId(x) })` NEVER matches: `has` resolves
  RELATIVE to the outer element, and a dialog-prefixed inner locator looks for a dialog
  inside the label. Use `page.getByTestId(x)` as the inner locator.
- g-confirm has TWO `.display` elements (the sum and the lead-capture card's „Chcete si
  objednať sami?") — scope to the „Suma na úhradu" card.
- The Platba modal auto-opens after a submit when the seed has an IBAN; close it before
  reading g-confirm.

### Mutations (fresh boot, `guest-packeta.spec.js -g GP-T3`)

M1 delivery keys always sent (1 red — the via_host payload test) · M2 component renders when
parcels are off (2 — parcel-off DOM + the one-home pin) · M3 e-mail label never flips (1) ·
M4 subtitle without the fee (1) · M5 g-confirm fee extra dropped (1) · M6 client regex drifts
from the mailer's (2 — the node mirror + the one-home pin; no rebuild needed) · M7 the three
client messages skipped (1) · M8 the Platba modal fed `order.total` (2 — the pixel QR + the
source pin) · M9 no reset on open (1) · M10 hero badge never renders (1) · M11 the cartbar
gains the fee (2 — the PO product-only pin, behavioural + source). ⚠ A mutation harness that
reverts with `replace(new, old, 1)` must assert `new` is UNIQUE: M4's `{{ fmtEur(cartTotal) }}`
also matches the cartbar, the revert „restored" the wrong line, and five later mutations
measured a corrupted tree (M11 was then added because that accident proved it reds).

### Seams

- GP-T4: mount `GuestDeliveryChoice` in edit mode (seed from `order.packeta_address`), import
  `EMAIL_SHAPE` from `lib/email-shape.js`, build the ALWAYS-sent delivery block yourself.
- WA-T1: the D6 sentence „Na toto číslo vám pošleme správu…" goes into this checkout modal.

---

## GP-T4 — the status page's Packeta state + edit mode, and the host card (2026-09-23)

**What shipped.** `views/GuestOrderStatus.vue` (read view: header sub „…organizuje {host} ·
doručí Packeta", the „Doručí Packeta" `statuspill off` REPLACING the delivered pill, the fee as a
`CartLineList` extra `status-delivery-fee`, `status-total` = `payment.amount`, the point card
`status-packeta-card` also on a cancelled order; edit mode: `edit-delivery-card` hosting
`GuestDeliveryChoice` above the grid, the write-once „E-mail *" `edit-guest-email`, the
parcels-gone `edit-parcel-unavailable` warn banner, the cartbar fee + `edit-delivery-fee` sub-line,
client validation into `edit-error`) and `components/GuestSubOrders.vue` (red `.badge.danger`
„Packeta" + mono point + „Tento kolega dostane balík Packetou — nemusíte nič odovzdávať." inside
the name block, no `guest-delivered-{id}` on Packeta rows + a JS guard in `toggleDelivered`,
`pendingDelivery` excludes them, fee-inclusive `.foot .total` + `guest-total-breakdown-{id}`).
No server change. `guest-packeta.spec.js` +16 tests (72 total).

### 23. „Always send the delivery block" vs „absent = untouched" — both hold, for different clients

GP-T2's seam said „send `use_parcel_delivery` ONLY from the delivery card"; GP-T3's said „the
ALWAYS-sent delivery block"; §UC-GP-007 item 9 says „always sent in edit mode". The orchestrator
ruled: follow the spec. So every non-empty SAVE from this screen carries the flag — `true` only
for a Packeta choice on a round with `parcel_enabled`, `false` otherwise (via_host, a parcel-off
round, and the parcels-gone banner, which is rule 5's `false` by construction). GP-T2's
„absent/null = untouched" contract is unchanged and still pinned API-level — it serves every OTHER
client (and the shipped items-only PUT). Consequence recorded: a plain via_host save on a
parcel-OFF round now writes `delivery_fee = 0, packeta_address = NULL` through the `false`
statement instead of the shipped two-column one — the same values, no shipped pin reads the
request body of a non-cancel save (grepped: `guest-status-shell.spec.js`'s `recordWrites` pins
only cancels). The CANCEL payload is untouched: `confirmCancel()` sends the literal
`{ items: [] }` (it now calls `submitEdit({ items: [] })` — `submitEdit` takes the whole body).

### 24. The edit-mode guard is `parcelEnabled && method === 'packeta'`, exactly as the checkout's

On the parcels-gone state the method is SEEDED `'packeta'` (the order has a point) while no card
renders. A raw `method === 'packeta'` would send `true` and meet the server's 400 — mutation M7
reds only the parcels-gone test, which is the one that proves the guard.

### 25. The write-once e-mail input asks the LOADED order, never the form

`editNeedsEmail = editIsPacketa && !order.guest_email`. After a save that stored an e-mail the
re-entered edit shows no input (pinned). The server ignores a body e-mail beside a stored one
(GP-T2 §10), so this is UX — but the spec's „never shown when an e-mail exists" is the identity
freeze on this surface. `guest-status-shell.spec.js:513`'s „`input` count 0 in edit mode" holds
because its fixtures are parcel-off (no radios, no inputs); the view's header claim „Items-only by
construction" is struck + pointed at this row.

### 26. The host tick is ABSENT, not disabled — and the handler refuses too

`v-if="!isPacketa(subOrder)"` on the whole `<label>`, plus `isPacketa` in `toggleDelivered`'s
early return (a dispatched click ignores a missing/disabled control — CLAUDE.md). `PATCH
…/delivered` is untouched server-side (§UC-GP-008 rule 2 — harmless, recorded): the status-page
test ticks a Packeta bag through the API and asserts the page STILL renders no delivered pill,
which is what discriminates „replaced" from „both" (M1).

### 27. `pendingDelivery` vs `count` — the fixture that tells them apart

The tab badge is `isLocked && pendingDelivery > 0 ? pendingDelivery : count`. One Packeta + one
via_host live row on a LOCKED round ⇒ `1` (count would be `2`); ticking the via_host row drops
`pendingDelivery` to 0 and the badge falls back to `count` = `2`. Both halves pinned. `count` and
`totals` are unchanged — a Packeta colleague is still a colleague, and the heading's
„spolu {totals.total}" stays product-only (GSO-T5, asserted by API `{count:2,total:49.8}` AND on
screen).

### 28. The badge lives in the NAME BLOCK, so two shipped pins keep their meaning

Outside `sub-order-badges` (its „exactly one" pin), inside the fold `<button>` as `display:block`
spans (no `<div>` in a button). ⚠ `colleagues-panel.spec.js`'s card-wide
`card.locator('.badge').count() === 1 + group headers` WOULD count the Packeta badge — it holds
only because every shipped fixture is via_host; a future Packeta fixture in that file must add 1.
A cancelled Packeta row keeps the badge + point (the record) but NOT the „nemusíte nič
odovzdávať" sentence, and its struck amount stays `cancelledTotal()` (items).

### 29. The foot total's wrapper

`.foot .total` now sits in a column `<div>` with the optional breakdown `.sub` — on EVERY row, so
the DOM shape does not branch on the fee. `colleagues-panel`'s font/family pin reads `.total`
itself and is unaffected.

### Mutations (fresh boot, `guest-packeta.spec.js -g GP-T4`, each rebuilt)

M1 delivered pill kept beside the Packeta one (1 red) · M2 `status-total` = `order.total` (3) ·
M3 point card hidden when cancelled (1) · M4 block sent only for Packeta (2) · M5 e-mail input
despite a stored e-mail (3) · M6 client validation skipped (1) · M7 `editIsPacketa` not
parcel-guarded (1) · M8 `pendingDelivery` counts Packeta (2) · M9 tick on Packeta rows (2) · M10
host foot product-only (1) · M11 badge inside `sub-order-badges` (1) · M12 cancelled row drops the
badge (1) · M13 cartbar without the fee (2) · M14 no re-seed on edit entry (1) · M15 no
parcels-gone banner (1). All 15 red.

### Seams

- GP-T5: the admin nested row / receivables are untouched here; `GuestDeliverySwitch.vue` is its.
- GP-T6: the host card still lists a Packeta sub-order under the host (this module's host view is
  `GUEST_ORDER_FIELDS`-driven); only the `/distribution` payload splits it into its own party.

---

## GP-T5 — the admin delivery correction, the receivables amount, the refund, the admin nested row (2026-09-23)

**What shipped.** `helpers/pickup.js applyGuestDelivery(row, { method: 'via_host' })` (NEW —
the guest mirror of `applyPickup`'s Packeta clearance, one statement: `UPDATE guest_orders SET
packeta_address = NULL, delivery_fee = 0 WHERE id = ?`, returns `{ cleared_parcel,
parcel_fee_removed }`), `PATCH /api/guest-orders/:id/delivery` (per-route `requireAdmin`,
`ADMIN_ENDPOINTS`), `/unpaid` rows += `delivery_fee` / `packeta_address` / `packeta` with the
live amount `total + fee` and the refund `items + (paid ? delivery_fee_paid : 0)`,
`components/GuestDeliverySwitch.vue` (NEW — the ONE correction control; GP-T6's Distribution
row is its second consumer), `api.switchGuestDelivery(id)`, and `CycleDetail.vue` (nested row:
red „Packeta" badge + 📦 point + fee-inclusive amount with the friend rows' breakdown +
the switch; receivables card: badge + point + breakdown; refund card: badge + point + an
informational note). `guest-packeta.spec.js` +16 tests after review (89 total), the ledger test extended,
both remaining `setLiveFee()` calls re-pointed, the fixture writer DELETED.

### 30. The PATCH contract, in gate order

`requireAdmin` (401 anonymous / host Bearer / stale token) → body EXACTLY `{ method:
'via_host' }` (plain object, one own key, strict equality — `{}`, `[1]`, `['via_host']`,
`{method:'packeta'}`, `'VIA_HOST'`, `[x]`, `null`, `true`, a stray `packeta_address` or
`delivery_fee` beside it ⇒ 400 `Neplatný spôsob prevzatia` · `method`; scalar JSON bodies never
reach the route, express.json strict ⇒ 400) → 404 uniform → 409 `cancelled` (`Táto objednávka
bola zrušená, spôsob prevzatia už nie je možné zmeniť.` — PO DRAFT; admin audience, so the
vocabulary guard does not apply, and it says „objednávka" anyway) → a transaction that
re-reads the row (gone ⇒ 404, cancelled ⇒ 409) and calls the helper. **No cycle gate** (pinned
on a LOCKED round), **no paid gate**. An already-via_host row ⇒ 200 `cleared_parcel: false,
parcel_fee_removed: 0`, row byte-identical. A fee-0 Packeta row clears too (`cleared_parcel:
true`, removed 0) — the address is the marker (§1). Response = `mutationPayload()` (the GSO-T5
`{ guest_order, totals }` shape) + the two flags.

### 31. The PATCH does NOT write `delivery_fee_paid` — and a paid switch SETTLES the fee (refund counts the snapshot only while `packeta_address IS NOT NULL`; orchestrator decision, pending PO)

The two-writer walk (§6) stays green: the snapshot is still frozen only by the first of {paid,
cancel}. ~~Consequence on a PAID Packeta row: … a LATER cancel refunds 28.40 (pay → PATCH →
cancel ⇒ refund 28.40).~~ → **SUPERSEDED in the GP-T5 review — that refunded the fee TWICE**:
the confirm tells the admin to return the 3.50 at the switch, and the later cancel then queued
28.40 again. **ORCHESTRATOR DECISION 2026-09-23 (option (a), PENDING PO): switching a PAID row
to „cez {host}" SETTLES its fee**, so the refund counts the snapshot only while the order is
still Packeta:
`refund = items + (paid && packeta_address IS NOT NULL ? delivery_fee_paid || 0 : 0)`.
The switch NULLs the address and the cancel keeps it, so the address is exactly „never
switched". No new writer — the snapshot stays in the row, the refund just stops counting it;
`paid = 1` stays in the QUERY. Pinned, each read back: pay → switch → cancel ⇒ 24.90 (snapshot
still 3.5, address NULL); pay → cancel ⇒ 28.40; unpaid → switch → cancel ⇒ not in `refunds`.
⚠ **Reviewer's edge, recorded (GP-T1's toggle rules, not fixed):** on a switched PAID row an
un-tick NULLs the snapshot (a live row) and the re-tick copies the live 0 — the server-side
trace of the settled overpayment is gone (pinned as documented behaviour).
**Refund note (review minor):** `/unpaid` rows publish `refund_fee` — EXACTLY the fee part
`amount` counts (0 on live, unpaid, switched and fee-0 rows); the raw `delivery_fee_paid` is
never published (pinned by key) and stays off `GUEST_ORDER_FIELDS`. The refund card's note is
driven by `refund_fee > 0` and prints it: „vrátane 3.50 EUR uhradeného poplatku za doručenie
Packetou" (PO DRAFT). §36's fee-0 caveat is thereby fixed.

### 32. The refund: `paid = 1` in the SQL AND in the formula — two layers, source-pinned

`delivery_fee_paid` is off `GUEST_ORDER_FIELDS` (deliberately), so `/unpaid` selects it BY
NAME in its own query — `WHERE glink.cycle_id = ? AND gord.paid = 1 AND gord.status =
'cancelled'` — and the formula still reads `row.paid ? snapshot : 0`. Since GP-T1 an UNPAID
cancelled row carries a snapshot (pinned non-vacuously in the `/unpaid` test), but the JS
queue filter (`status === 'cancelled' && !!row.paid`) already keeps it out of `refunds`, so
**neither layer is behaviourally observable on its own** — M1/M2 below red only the source pin,
the same class as §4's in-tx re-read. The live amount is now `roundMoney(total + fee)` (was the
bare `total`; identical for every via_host row, whose total is already rounded).

### 33. `setLiveFee()` is GONE — the PATCH models both remaining steps

GP-T2 left two fixture writes that moved the fee of a PAID row (§12). The delivery PATCH is a
real writer of exactly that — it moves the live fee to 0 — and 0 is the DISCRIMINATING value
for both COALESCE writers: a plain copy freezes 0 and the refund loses the fee. So:
„live pay → unpay → reprice → pay → PATCH → re-tick" asserts the snapshot stays 4 after the
live fee went to 0 (paid=1 plain-copy mutation reds it), and „pay → PATCH → cancel" asserts the
cancel keeps the tick's 3.5 (cancel-overwrite mutation reds it). The node:sqlite read-WRITE
open is gone from the file (every remaining `DatabaseSync` is `readOnly`).

### 34. The stale guest tab — DECIDED: accepted risk, no server guard

GP-T4's review: a guest status tab opened BEFORE the admin's correction still shows Packeta;
its next save ALWAYS sends `use_parcel_delivery` (20 §UC-GP-007 item 9), so it writes Packeta +
the fee back while parcels are on. Last-write-wins, exactly like the item cart. Decision: **no
guard.** The spec is silent; the edit only accepts an open, unpaid order (409 `closed` / `paid`
otherwise, so the paid-row case cannot recur and a locked round cannot be re-Packeta'd); the
value written is the guest's own visible choice; and a guard would need a version/ETag the
payload does not carry, or would turn the always-sent flag into a refusal for the ordinary
save. The admin re-corrects if needed. Pinned as documented behaviour (the API test re-applies
Packeta after the PATCH) and recorded in 20 §Accepted risks.

### 35. `GuestDeliverySwitch.vue` — built for its second consumer

Props `guestOrderId` (the guest's OWN id — `PickupLocationPicker` is never handed one, its key
is (cycle, friend)), `hostName` (first name), `deliveryFee`, `testidPrefix` (default
`guest-delivery` ⇒ `guest-delivery-switch|confirm|warning|yes|no|error-{id}`). It OWNS its
mutation (the `PickupLocationPicker` reasoning: two views that never coexist), so pending is per
instance = per `guest_orders.id`; a `seq` counter + a `guestOrderId` watch drop a late response
and reset a re-bound slot. `:disabled` AND a JS guard (`if (pending.value || !confirming.value)
return`) — pinned by holding the request and dispatching a second click (1 call). A refusal
stays next to the control, the confirm stays open, the row keeps its Packeta state. The
PARENT renders it only on a LIVE Packeta row and patches its row from `updated`
(`onGuestDeliveryUpdated`: point + fee from `guest_order`, then `loadGuestUnpaid()` +
`loadDistributionPlan()` — the receivables amount and the header plan both move). Fee 0 ⇒ the
confirm reads „Zruší sa doručenie Packetou." (the picker's own fallback). Admin skin only —
the PI-T12 admin-invariance sweep reads it through the admin import closure.

### 36. Admin rendering

Nested row: badge + 📦 point on EVERY Packeta row, cancelled included (the record — same rule
as the host card); amount `formatPrice(total + fee)` + `(X EUR + Y EUR doručenie)` when fee >
0 (the friend rows' wording); the via_host row is byte-identical (its 4-button count pin in
`guest-admin-view.spec.js` holds; the switch never renders there). Receivables: badge + point
under the phone line, amount + breakdown. Refund: badge + point, amount, and „vrátane
uhradeného poplatku za doručenie Packetou" when `packeta` (PO DRAFT) — ~~„+ poplatok za
doručenie Packetou (suma podľa objednávky)"~~ is superseded in 20 §UC-GP-006 because the fee
is now IN the amount (adding it by hand would refund it twice). ~~⚠ A fee-0 Packeta refund would
still show the note~~ → fixed in review: the note reads `refund_fee` (§31).

### 37. Harness trap met

A Python `str.index`-then-splice done twice with the SAME needle, where the replacement starts
with the needle, hits the first site twice: both new blocks landed in the receivables card and
the refund card got none. One UI test caught it. Replace from the END, or search after the
first insertion. ⚠ **Second trap (review round):** a fixture built with the API AFTER the UI
admin login made `makeAdmin` re-login on a 401, which rotated the ONE `admin_token` out of the
browser — the page dropped to logged-out and the test timed out on the tab. The first R4
mutation run was „red" for THAT reason, not for R4; the fixture was moved before the UI login
and R4 re-measured (red on the intended assertion: note count 1, expected 0).

### Mutations (fresh server boot / rebuild per mutation; GP-T5 + snapshot + ledger + admin-authorization)

Each backend mutation restarted the server on the same DB, each frontend one rebuilt
`backend/public`; the file was restored and byte-compared after each.

| # | Mutation | Red |
|---|---|---|
| M1 | `paid = 1` dropped from the snapshot SQL | 1 (source pin only — §32) |
| M2 | refund formula not paid-gated | 1 (source pin only — §32) |
| M4 | live `/unpaid` amount product-only | 2 |
| M5 | refund items-only | 4 |
| M6 | the PATCH also NULLs `delivery_fee_paid` | 5 (incl. the two-writer walk) |
| M7 | no `requireAdmin` on the PATCH | 3 (incl. `ADMIN_ENDPOINTS`) |
| M8 | extra body keys tolerated | 1 |
| M9 / M9b | the 409 `cancelled` pre-check / the in-tx re-check dropped ALONE | 0 / 0 — redundant layers by design (the GA-T8 note) |
| M9c | BOTH cancelled layers dropped | 1 |
| M10 | a cycle-open gate added | 1 |
| M11 | `packeta` marker from `fee > 0` | 2 |
| M12 | the PATCH keeps the point | 8 |
| M13 | paid=1 plain copy (not COALESCE) | 4 (incl. the re-pointed §33 test) |
| M14 | cancel overwrites the snapshot | 3 (incl. the re-pointed §33 test) |
| F1 | no JS guard in the switch | 2 |
| F2 | row not patched in place | 1 |
| F3 | switch on every live row | 1 |
| F4 | confirm without the fee | 1 |
| F5 | receivables not reloaded after the switch | 1 |
| F6 | nested amount product-only | 2 |
| R1 | (review) refund formula without the `packeta_address` condition | 3 |
| R2 | (review) refund formula without `paid` (SQL keeps `paid = 1`) | 1 (source pin only — §32) |
| R3 | (review) `refund_fee` = the raw snapshot | 3 |
| R4 | (review) note driven by `packeta` instead of `refund_fee` | 1 (the fee-0 refund row) |

### Seams

- GP-T6: mount `GuestDeliverySwitch` on the Distribution Packeta guest party (`guest-order-id`
  = the party's `guest_order_id`, `host-name` = first name of `host_name`), patch the party from
  `updated`, re-fetch the plan. Do NOT copy the confirm.
- WA-T5: a PATCH after a hand-over leaves a queued Packeta-segment message on its frozen
  `segment_key` (DP-T3's note) — same class, same owner.
