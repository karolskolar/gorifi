# Admin sets a party's pickup point (helpers/pickup.js, PickupLocationPicker.vue)

> Moved verbatim out of `CLAUDE.md` on 2026-09-03 (it had grown to 153 KB). These are the full per-task learnings; the load-bearing rules are summarised in `CLAUDE.md` → Hard rules. **Append new learnings for this area HERE, and add only the one-line rule to `CLAUDE.md`.**

### Admin sets a party's pickup point, under all circumstances (PO, 2026-09-02 + 09-03)

`orders.pickup_location_id` / `pickup_location_note` were **write-once** — set by the
friend in `POST /orders/cycle/:cycleId/friend/:friendId/submit` and by nothing else — so
a wrong or since-changed pickup point could not be fixed and the Distribúcia sheet
disagreed with where the bags actually go.

⚠ **Shipped twice in two days, and the second day REPLACED the first.** 09-02 shipped
`PATCH /api/orders/:id/pickup` for submitted, non-Packeta orders. The PO then reported
the hole from a screenshot — *"ak priateľ neobjedná kávu a iba jeho neregistrovaný
kolega si objedná, nie je v sumáre objednávok zobrazenie pick up pointu"* — and asked
for it **"za každých okolností"**. That host has NO `orders` row, so an order-id route
could not address them at all. The live route is
**`PATCH /api/orders/cycle/:cycleId/friend/:friendId/pickup`** (`requireAdmin`); the
order-id one is **deleted, not deprecated** — two write paths to the same column is the
drift this file keeps warning about.

**⚠ `backend/src/helpers/pickup.js` IS THE ONE HOME for choosing the store.** A party's
pickup lives on their `orders` row when one exists (**any** status, draft included) and
on their **`guest_order_links`** row otherwise — one row per (host, cycle), which always
exists when guest bags do.
- ⚠ **THE CHOICE CANNOT BE MADE PER SURFACE, and this is the subtle part.** The orders
  tab lists a party who has an order **OR** guest bags; `/api/cycles/:id/distribution`
  builds its no-own-order rows `FROM orders … WHERE status = 'submitted'`. So a host
  sitting on a **draft** is "has an own order" to one screen and not to the other — a
  per-surface store would have written `orders` from the orders tab and read the link
  back on the picking sheet, for the same party. `pickupTargetFor()` answers "does an
  `orders` row exist", a fact about the database and not about the caller. Pinned by a
  test that writes once and reads **both** payloads for exactly that party.
- The synthetic distribution row's `pickup_location_*` were **hardcoded `null`**
  (`cycles.js`); they now come from `readPickup()`. The orders listing fills the same
  three fields onto every `id: null` placeholder from `linkPickupsByHost()`, so the
  frontend has ONE shape to render and one to patch regardless of store.
- ⚠ `pickupOf()` looks the location name up **without `active = 1`** — a place
  soft-deleted after an order chose it must still render its name, or the badge goes
  blank on a party whose pickup is perfectly well defined.

**⚠ The two new columns on `guest_order_links` are BOTH in the CREATE and in an
`ALTER TABLE` migration**, which is a deliberate exception to the GSO-T2 rule that the
three guest tables "never have to touch migrations". That rule stops a later task
re-declaring what the CREATE already has; these are genuinely new columns on a table
that already exists in prod and staging, where `CREATE TABLE IF NOT EXISTS` is a no-op —
without the migration the feature would work only on a database built from scratch.

**Money — what the route may and may not touch.**
- ⚠ **NO `transactions` ROW, EVER**, and no `total`/`status`/`paid`/`packed` write. That
  is the only reason it is safe to offer on a locked, part-paid cycle (the GSO-T6 lesson
  — a stray row corrupts a real friend's balance). Pinned by moving the pickup on a
  **paid** order and asserting the ledger row count is unmoved.
- ⚠ **The one money column it may move is `delivery_fee`, on a PACKETA order being
  switched to personal pickup** — a **conscious reversal** of 09-02's flat refusal.
  `packeta_address` and the pickup columns are mutually exclusive by construction, so
  leaving the fee would claim a delivery charge for a delivery nobody makes; both parcel
  fields are cleared with the switch.
- ⚠ **AND IT IS LEDGER-NEUTRAL — verified in the code, not assumed.** `PATCH
  /orders/:id/paid` posts `roundMoney(order.total)` and `helpers/packing.js` charges
  `-roundMoney(order.total)`: **both legs use `total` alone, and `delivery_fee` has
  never entered `transactions` at all.** So zeroing it moves no balance and invalidates
  no existing row. What it does change is what the friend was **asked** to pay
  (`paymentTotal = total + delivery_fee`, and the QR built from it) — which is why this
  ONE case sits behind an inline confirm that **names the amount**. Pinned by switching
  a *paid* parcel order and asserting the ledger is untouched while fee and address go.
- ⚠ **Switching TO Packeta is deliberately NOT offered.** It needs an address the admin
  does not have; `friends.packeta_address` holds only the friend's default.

**⚠ Other invariants, unchanged from 09-02.**
- **NO CYCLE-OPEN GATE** — the correction is needed exactly when the cycle is **locked**,
  because that is when the admin packs (same basis as `PATCH /:id/packed`). A test
  asserts the locked case *works*, so nobody "fixes" it into a 409.
- **EXPLICIT INTENT: exactly one of `pickup_location_id` / `pickup_location_note`.**
  `{}`, both, or neither is a 400 that writes nothing (the GSO-T4 `items: []` rule in its
  non-destructive form). Consequence, recorded: there is deliberately **no way to clear a
  pickup back to empty** — the admin's job here is to name the FINAL place. Every refusal
  test **reads the row back**; a status assertion cannot see a write that happened anyway.
- Refused: an unknown cycle, a party with **neither** store (404 — not listed on the
  orders tab either), an unknown or **deactivated** location, a note over **200 chars**
  (module 11 bound, mirrored as `maxlength`), and the FUP-T13 unbindable shapes — `{}` /
  `true` / `[id]` / `'abc'` are 400s, never a 500 with a stack. ⚠ The **one-element
  array** is the trap as always: `[3]` spreads to exactly the single bind slot the
  statement wants. ⚠ A test re-applies the whole bounds set **through the link store**,
  because that is a separate `UPDATE` and "the guards are shared" is otherwise a claim.

**⚠ `components/PickupLocationPicker.vue` — THE PILL *IS* THE `<select>`.** One home,
**two call sites in two different views**: `CycleDetail.vue`'s orders tab (the Status
column, where the badge already lived) and `Distribution.vue`'s friend card.
- The obvious build — badge, click to reveal a picker, pick, Uložiť — is three
  interactions and hides the control behind a state the admin has to discover. A native
  `<select>` styled as the shipped badge is **two** (open, pick), **saves on pick**, keeps
  the colour coding at rest (**blue** = configured location, **grey** = the friend's
  "Iné" note, **red** = still going by Packeta, **dashed** = nothing set) and costs no
  portal in a 33-row table. Native `<select>` with these exact Tailwind classes is the
  established admin-skin pattern (`AdminCatalog.vue`).
- ⚠ **Props are `cycleId` + `friendId`, never an order id**, and the component does not
  know which store the write lands on — if it ever starts guessing, the two surfaces
  drift apart again. Testids are keyed on the **friend** id for the same reason.
- ⚠ **It owns its own mutation, diverging from `GuestLinkRowControls.vue` on purpose.**
  That one keeps pending state in the parent because its two call sites render the SAME
  friend in the SAME view. Here they are separate views that never coexist, so
  parent-owned state would mean the identical optimistic-patch/rollback logic twice.
  Parents pass current values and patch their row from `updated`.
- ⚠ **`cleared_parcel` must be mirrored into the row** by both parents, or the row keeps
  rendering the parcel it no longer has: red "Packeta" over the new location, plus
  "(… + fee doručenie)" in Suma, plus the 📦 address line on the Distribution card.
- ⚠ **`v-model` on the select, NEVER `:value`.** Vue's `v-model` for `<select>`
  re-applies the selection *after* the `v-for` options are patched; a bound `:value` is
  set before its options exist and silently falls back to the first option.
- ⚠ **A refused change snaps the pill back.** The packing sheet is read as fact; "it
  looked like it saved" is how a bag goes to the wrong address.
- ⚠ **In Distribution the picker is `print:hidden` and BOTH badges are
  `hidden print:inline-flex`** — the pickup badge *and* the Packeta one. A printed
  picking sheet must state the place as TEXT, not render a dropdown box (the guest folds'
  rule); on screen the pill already says the same word in the same colour, so an
  always-visible badge would be the word twice. ⚠ In the print test the badge must be
  located by **testid** (`dist-pickup-badge-<friend.id>`), not by text: the select's own
  hidden `<option>` carries the same string, so `getByText` resolves to the very control
  the test is proving is gone.
- Both views load the location list **after** the cycle is known (filtered by cycle type,
  `for_coffee` / `for_bakery`, as the friend's order form filters it) and swallow the
  failure into **its own inline Alert** — an empty dropdown and a failed load look
  identical, and "no places are configured" would send the admin to Settings to
  re-create places that already exist.

**Not done, and worth knowing.** The friend portal still shows pickup from the friend's
own order only (`friends.js` `orderPickupName`), so a host with no own order does not see
where to collect their colleagues' bags — the link store has no friend-facing reader yet.
Guest sub-orders themselves carry no pickup at all: the host is the pickup party and
hands over (`delivered` is host-only), which is the model the whole guest feature is
built on.

Spec: `e2e/tests/order-pickup-edit.spec.js` (35 tests, API + UI on both surfaces);
`api-security.spec.js`'s `ADMIN_ENDPOINTS` carries the route. Verified against the prod
template: **35** in that file, **396** across `api-security` / `guest-distribution` /
`item-packed` / `guest-admin-view` / `money-rounding` / `nonstring-body-shape`, and
**171** across `guest-order-recovery` / `guest-host-view` / `guest-link` /
`share-dialog` / `guest-aggregation` / `guest-rewards`. ⚠ Two `catalog-admin.spec.js` UI
tests (CSV import report, duplicates merge) fail on any DB copy that has already run that
file once and pass in 3.3 s on a fresh copy — the documented accumulation trap, unrelated.

