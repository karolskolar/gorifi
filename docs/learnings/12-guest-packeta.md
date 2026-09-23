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
refund formula gates on `paid`. The live-fee step writes the column from the test (node:sqlite,
read-write) because no route can change a live fee until GP-T2 / GP-T5. ⚠ **When GP-T2 (the edit
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
