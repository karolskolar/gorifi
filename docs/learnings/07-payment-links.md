# 07 — Payment links (module 15)

Per-task write-ups for `docs/specification/15-payment-links.md`. Read this before touching
`backend/src/helpers/payment.js`, the payment settings routes or anything that emits a
variable symbol.

---

## PL-T1 — `helpers/payment.js`, the `payment_creditor_name` setting, seed 3b (2026-09-19)

**What shipped.** A new one-home helper plus a third payment setting. No schema change, no
migration, no new route — the variable symbol is DERIVED from an id that already exists
(spec decision D1), and the two settings endpoints already existed.

`backend/src/helpers/payment.js` exports:

| Export | Contract |
|---|---|
| `friendOrderVariableSymbol(orderId)` | `String(orderId)` — plain, no prefix, no padding |
| `guestOrderVariableSymbol(id)` | `'9' + String(id).padStart(6,'0')` |
| `balanceVariableSymbol(friendId)` | `'8' + String(friendId).padStart(6,'0')` |
| `paymentSettings()` | `{ iban, revolut_username, creditor_name }`, each `''` when the row is absent — ONE query, ONE reader |
| `guestPaymentBlock(order, cycleName)` | `{ amount, reference, variable_symbol, iban, revolut_username, creditor_name }` |
| `MAX_CREDITOR_NAME_LENGTH` | `70` — the server bound AND the source of the UI `maxlength` |

**The collision rule is the whole point, and it is enforced by a RANGE GUARD, not by
hope.** Every derivation requires `Number.isInteger(id) && id > 0 && id < 1_000_000`;
anything else returns `''` and logs one line carrying only the kind and the `typeof` (a
refusal is not a reason to write a friend's or a guest's row into the log). The reason for
the upper bound is exact: an `orders.id` of 8,000,000+ would render as a 7-digit string
starting with `8`/`9` — precisely a balance or guest VS. Below 1,000,000 the three spaces
are provably disjoint. An empty VS is a degraded payment (the QR still carries the human
reference); a wrong VS is money matched to the wrong person.

**Two payment helpers, and why that is not a second home.** `guestPaymentReference()` has
lived in `helpers/guest-orders.js` since GSO-T3 and is named in CLAUDE.md's one-home list.
It STAYS there (§UC-PL-001 says so) and `helpers/payment.js` imports it. The split is by
CONCEPT: `guest-orders.js` owns "how a guest sub-order describes itself" (it is built from
`order.guest_name`, it is pinned by four shipped specs, and its four call sites already
import that module for the surrounding row loaders); `payment.js` owns "what the payer is
told to do". Moving the function would have touched four call sites, four spec headers and
the CLAUDE.md list to produce a differently-named identical function. The rule to keep:
**one formatter per concept — the defect would be a second `G<id>` builder or a second
`padStart(6`, not the existence of two files.** The second half is machine-checked:
`payment-links.spec.js` walks `backend/src` and fails if `padStart(6` appears anywhere but
`helpers/payment.js` (with a non-vacuity gate that the helper itself contains it).

**What was RE-POINTED at the new reader, and what deliberately was not.**
- `routes/admin.js` `GET /settings` and `GET /payment-settings` now read through
  `paymentSettings()` — **exactly two call sites**; the four hand-written `SELECT value FROM
  settings` reads are gone. ⚠ `PUT /settings` is NOT one of them and never was: it only
  WRITES, and it imports `MAX_CREDITOR_NAME_LENGTH` plus (PL-T1 review) the three
  `SETTING_*` key constants, so the write keys cannot drift from the read keys. A drifted
  write key stores a setting nothing ever reads back — the same typo bug one direction
  further along, and invisible to anything but a round-trip.
- `routes/guest.js`'s private `paymentSettings()` (a duplicate of the same two reads) is
  deleted and the module import takes its place. The returned shape is unchanged for its
  two callers, so no payload moved.
- ⚠ `guestPaymentBlock()` is **defined but not yet wired into `routes/guest.js`**. The two
  hand-written guest `payment` blocks still stand: making them go through the helper ADDS
  `variable_symbol` + `creditor_name` to a public payload, which is **PL-T2's** row
  (§UC-PL-003 item 1) and its acceptance criteria. PL-T2 replaces both blocks with one
  call each; nothing else about them changes.

**⚠ Module-20 seam, already written down at the line.** `guestPaymentBlock().amount` is
`order.total`. GP-T1 changes that ONE line to `total + delivery_fee` (`orders.total` stays
product-only on every write), and the seam comment in the helper says so. The
`guestPaymentBlock()` expectation in `payment-links.spec.js` moves with it.

**The setting.** `payment_creditor_name`, `settings` key/value, no column. `PUT
/api/admin/settings` binds it with `bindValue()` exactly like the other two payment keys
(FUP-T13: unbindable ⇒ `undefined` ⇒ the write is skipped and the stored value survives —
a one-element array is the trap), then trims it **only when it is a string** (a finite
number is bindable and calling `.trim()` on one is the FUP-T12 class of 500 this handler is
already hardened against). Over 70 characters ⇒ `400 { error: 'Meno príjemcu môže mať
najviac 70 znakov' }`, and the check sits **before every `INSERT OR REPLACE` in the
handler**, so a refused name leaves the IBAN and the Revolut handle in the same request
unwritten too. Trim runs before the bound check, so a 70-character name padded with spaces
is legal.

**⚠ `GET /api/admin/payment-settings` STAYS PUBLIC** — it is the one unguarded route under
`/api/admin` (`api-security.spec.js:150` lists it among the public endpoints, not in
`ADMIN_ENDPOINTS`), because every friend and guest payment screen reads the IBAN from it
while authenticated as nobody. The creditor name is public data by definition — a bank
transfer shows the account holder to the payer — so it joins that payload. The spec pins the
property explicitly (anonymous 200, a wrong token still 200, `GET /settings` still 401)
because it is exactly the kind of thing someone later "fixes".

**⚠ The 70 is ISO, not a verified PayMe quote.** §UC-PL-002 left it OPEN ("verify against
payme.sk during the first task"). Attempted and NOT resolved: payme.sk's developer page
lists the parameters (`V`, `IBAN`, `AM`, `CC`, `DT`, `PI`, `MSG`, `CN`) but states no caps,
and the SBA *Payment Link Standard* PDF (v1.2 / the referenced v2.0) is not text-extractable
here — encoded fonts, no readable strings. 70 is the SEPA / ISO 20022 beneficiary-name
length (`Nm`) that the Pay by Square payload already follows, so it is the defensible
default. If the standard turns out to be shorter, `MAX_CREDITOR_NAME_LENGTH` and the
`maxlength` move together — they are one number with one home (the helper exports it; the
UI mirrors it; the spec asserts both are 70).

**Seed.** `e2e/seed.mjs` 3b gained a **separately guarded** creditor-name write. It is NOT
folded into the existing "only when BOTH are empty" IBAN/Revolut branch on purpose: on any
environment that already has payment details (a real one, or a template rebuilt before this
key existed) the combined guard would skip the creditor name forever and every later
PayMe/QR-beneficiary test would pass vacuously on a blank setting. Same restraint though —
written only when empty, so a real environment's value is never overwritten. The spec asserts
the seeded value is non-empty, and does it in `beforeAll` **before** any test mutates it.

**Testing notes worth reusing.**
- The VS rules are tested by importing the helper in a throwaway `node --input-type=module -e`
  child against a throwaway `DB_PATH` (the `google-auth-verifier.spec.js` idiom) — importing
  it in the Playwright process would open the gate server's own database. The case list is
  passed as SOURCE TEXT and `eval`ed in the child, so `undefined`/`NaN`/`Infinity` are
  covered by one list and the failure message names the input.
- The gate is `fs.existsSync(backend/src/index.js)`, not the helper file: "the helper is
  missing" must be a RED run, not a silent skip.
- The UI block runs LAST in the file and the restore step re-logs-in, because a UI admin
  login invalidates the single app-wide admin session and would kill the API context's token.

**Verified (2026-09-19, fresh per-run copy of `e2e/fixtures/prod-template.sqlite`,
`--workers=1`):** `payment-links.spec.js` **24 passed**; `api-security` /
`nonstring-body-shape` / `guest-payment-modal` / `money-rounding` **355 passed, 16 skipped**
(the documented rate-limit/DB_PATH skips); `guest-order` / `guest-status` /
`guest-order-recovery` / `order-locked` / `guest-admin-view` **175 passed, 1 skipped**;
`self-hosted-fonts` / `modern-login` / `first-password` / `magic-link` / `google-auth` /
`guest-invite-dead` green.

**Recorded, not changed (PL-T1 review, 2026-09-19).**
- ⚠ **The creditor name is validated for LENGTH ONLY** — no control-character, newline or
  collapse-whitespace rule, matching the IBAN and the Revolut handle beside it. Harmless
  while it is only stored and echoed, but PL-T3 puts it into a **query parameter** (PayMe
  `CN=`) and into the **bysquare beneficiary name**, so `&`, `#`, `%`, `+` and a newline
  become that row's ENCODING problem: `encodeURIComponent` on the way into the link, and no
  raw interpolation into a URL string. Noted here and at the input-policy site
  (`routes/admin.js` `PUT /settings`) so the row inherits the warning instead of finding it.
- The browser's `maxlength="70"` counts UNTRIMMED characters while the server trims first,
  so the control is marginally stricter for a space-padded name (70 M's plus a leading space
  is refused by the input, accepted by the API). Harmless — the mirror is a guard rail, the
  server is the bound, and the server side is pinned both ways.

**⚠ For module closeout / the PO (escalated by the PL-T1 review).** `GET
/api/admin/payment-settings` is unauthenticated (a closed decision) and now pairs a real
IBAN with a real ACCOUNT-HOLDER NAME — the pairing is the new part, and it is exactly the
input a direct-debit mandate takes. It stays, because §UC-PL-002 mandates it and the
public-endpoint decision is closed. Cheap mitigation if it ever matters: serve
`paymentCreditorName` only from the payment-BEARING payloads PL-T2 adds (the guest block,
the friend order, the balance), and drop it from the bare settings endpoint — the client
surfaces that need it all fetch one of those anyway.

**Left open for the next rows.** PL-T2 wires `guestPaymentBlock()` and adds the VS to the
friend order, balance, unpaid-overview and orders-tab payloads; PL-T3 builds
`frontend/src/lib/payment-links.js` and the PaymentModal props; PL-T4 the friend surfaces
and the module closeout. `payment_creditor_name` is NOT in `e2e/scrub-template.sql`:
it is not a credential (the account holder's name is on every transfer) and friends' real
names are kept by PO decision — but if a template is ever rebuilt from a production that has
it set, seed 3b correctly leaves that real value alone, so no spec may hardcode the seeded
name.
