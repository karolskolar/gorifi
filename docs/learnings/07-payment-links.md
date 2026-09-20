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
- ~~⚠ `guestPaymentBlock()` is **defined but not yet wired into `routes/guest.js`**. The two
  hand-written guest `payment` blocks still stand: making them go through the helper ADDS
  `variable_symbol` + `creditor_name` to a public payload, which is **PL-T2's** row
  (§UC-PL-003 item 1) and its acceptance criteria. PL-T2 replaces both blocks with one
  call each; nothing else about them changes.~~ **SUPERSEDED by PL-T2 (below): both blocks
  are one `guestPaymentBlock()` call now, and `routes/guest.js` composes no payment data of
  its own — the two seam comments are discharged and gone.**

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

---

## PL-T2 — the VS in every payment-bearing payload, and on the admin's screen (2026-09-19)

**What shipped.** `guestPaymentBlock()` WIRED (the seam PL-T1 left open), plus a variable
symbol on five more payloads and two more surfaces. No schema change, no migration, **no new
route** — every field is derived from an id the payload already carried.

| Payload | Added |
|---|---|
| guest submit 201 + `statusPayload` (both URL forms) | the whole block now comes from `guestPaymentBlock()` ⇒ `variable_symbol` + `creditor_name` |
| guest confirmation mail | a „Variabilný symbol" row, directly after „Referencia", only when non-empty |
| friend order `GET`/`PUT`/`POST …/submit` | top-level `payment: { variable_symbol }`, `null` when there is no order |
| `GET /friends/:id/balance` | `payment: { amount, reference, variable_symbol, iban, revolut_username, creditor_name }` from the new `balancePaymentBlock()` |
| `GET /guest-orders/cycle/:id/unpaid` | `variable_symbol` on every `unpaid` and `refunds` row |
| `GET /orders/cycle/:id` (admin tab) | `variable_symbol` on friend rows and nested guest rows, `null` on placeholders |
| `CycleDetail.vue` | „VS … · " prefix on both receivables reference lines; a muted mono „VS …" on friend and guest rows |

**The refactor is where a silent change would hide, so the guest block is pinned three ways.**
Replacing two hand-written blocks with one call is exactly the kind of edit that quietly
rounds an amount or drops a `G` prefix. `payment-links.spec.js` therefore asserts (a) the 201's
block with a FULL `toEqual` object literal whose `amount`, `reference`, `iban` and
`revolut_username` are values the test itself chose, (b) an ORDERED `Object.keys` equality —
so a removed field and an unannounced added one both fail — and (c)
`JSON.stringify(status) === JSON.stringify(created)` across the 201, the canonical status form
and the legacy pair form: **one composer means the same key ORDER everywhere**, which a
`toEqual` would not have caught. `guest-order.spec.js:238` ("returns the order token + payment
info") and `guest-status.spec.js:155` passed unmodified, which is the independent half of the
same claim.

**⚠ A DRAFT IS NOT A DEBT — the one real design question this row turned up.** A draft cart
HAS an `orders.id`, so the admin payload legitimately carries its VS. Rendering it broke a
shipped pin (`guest-admin-view.spec.js:1237` asserts that money cell is exactly „-"), and the
pin was RIGHT: `isOrdered()` is the tab's one predicate and a draft contributes to nothing on
that screen, so quoting a symbol would invite the admin to chase a payment nobody was asked
for. Fixed in the VIEW (`v-if="isOrdered(order) && order.variable_symbol"`), not in the
payload — the payload states a fact, the screen decides what is money. Both halves are now
pinned (API: a draft row carries `String(order.id)`; UI: its row contains no „VS ").
⚠ The shipped spec file was NOT edited: a pre-existing test failing under a new feature is the
feature's problem until proven otherwise.

**Placement facts worth keeping.**
- `listedOrders` renders `status === 'submitted' || 'draft' || guest_orders.length > 0`, so a
  friend with NO order and no guest bags never appears — the `variable_symbol: null` case is
  only visible on screen through a **host whose colleague ordered but who ordered nothing**.
  A test that used a plain friend for it failed on a missing row, not on the rule.
- The admin VS is computed in ONE pass at the end of `GET /orders/cycle/:id`, after both
  placeholder loops and the link-pickup fill, so every row shape the endpoint can emit goes
  through the same line. The guest half is mapped into NEW objects — `cycleSubOrdersByHost()`
  is shared with `routes/cycles.js` and must not be mutated under it.
- `null` (no debt) and `''` (the helper REFUSED an out-of-range id) stay distinguishable on the
  admin row; the view's `v-if` treats both as "render nothing".

**The friend order payload deliberately carries ONLY the symbol.** No `iban`/`revolut_username`:
`FriendOrder.vue` keeps its `api.getPaymentSettings()` read, and `money-rounding.spec.js:693`
mocks exactly that endpoint to make the friend QR hermetic — moving the settings into this
payload would have turned that mock dead without failing anything. Pinned as
`Object.keys(payment) === ['variable_symbol']` plus "no IBAN string anywhere in this payload".

**Balance — and the second helper this row added, deliberately.** `helpers/payment.js` gained
`balancePaymentBlock(friend)` beside `guestPaymentBlock()`. Composing it inline in
`routes/friends.js` (which is how it was first written, and how §UC-PL-003 item 4 phrases it)
would have made it **the second hand-written payment block in the codebase** — the exact shape
of the defect PL-T1 created `guestPaymentBlock()` to prevent, with PL-T4's balance modal and
module 21's messages queued up as the second and third consumers. The rule stands as PL-T1
wrote it: one formatter per CONCEPT, and two blocks describing one debt is the defect.
`amount = roundMoney(Math.max(0, -balance))`, so a friend in credit or exactly settled is asked
for 0 and PL-T4's „Zaplatiť" simply never appears. The sign flip and the rounding live in the
HELPER so no screen can quote one debt with the other sign, and `-26.189999999999998` leaves as
`26.19` (the incident in `pricing.js`'s header, on the surface it actually happened on). Pinned
in the child-process probe — debt / settled / credit / float drift — as well as over HTTP. Reference is
`` `${friend.name} / zostatok` `` — ⚠ still DRAFT copy, PO sign-off pending (§UC-PL-003 item 4
OPEN). Publishing the IBAN here is not a new audience: the route is `requireFriendOwner`-guarded
and `GET /api/admin/payment-settings` is public anyway. The 403 (foreign Bearer) / 401
(anonymous) pins were re-asserted on the now-payment-bearing route, and a READ writes no ledger
row (asserted by counting the friend's transactions around three reads).

**Mail.** One label constant, one conditional push into the existing `paymentRows` array — the
one-array mechanism puts it in the text AND the html part. ⚠ The 08 §UC-EM-005 one-origin pin
is now asserted for **payme.sk by name** in both parts, beside the shipped `revolut.me` one:
PL-T3 builds those links, and the mail is the one surface they must never reach. The existing
"the only origin in the mail is the pinned one" host-set assertion is the structural half.

**Verified (2026-09-19, per-run copy of `e2e/fixtures/prod-template.sqlite`, `--workers=1`):**
`payment-links` **42 passed** (18 new); `payment-links` + `guest-admin-view` **72 passed**;
`guest-order-recovery` / `order-locked` / `order-cartbar` / `order-fidelity` / `order-modals` /
`money-rounding` **156 passed, 5 skipped** (documented); `guest-order` / `guest-status` /
`guest-payment-modal` / `api-security` / `guest-admin-view` / `money-rounding` / `order-modals` /
`portal-transactions-modal` **213 passed, 4 skipped**; `api-security` / `colleagues-panel` /
`guest-host-view` / `guest-distribution` / `guest-aggregation` / `item-packed` / `order-shell` /
`order-pickup-edit` / `nonstring-body-shape` / `malformed-body` green. `node --check` on all four
changed backend files.

**⚠ A run WITHOUT `--workers=1` produced 9 red files with mass 401s** on `POST /api/friends` —
the documented one-token-app-wide clobber, not a regression. Cost ten minutes; the tell is a
401 on a FIXTURE call, never on the assertion under test.

**Left for the next rows.** PL-T3 consumes `variable_symbol` + `creditor_name` on the guest
surfaces (they are in the payload now, unread); PL-T4 the friend surfaces and the balance
„Zaplatiť" UI — the balance payload is ready, the button is theirs. ⚠ The balance `reference`
copy needs PO sign-off before module closeout.

### PL-T2 review follow-ups (2026-09-19, approve + 3 minors — all fixed in the same commit)

**⚠ THE PATTERN IS NOW THE LESSON: a rule written narrower than the thing it protects.**
Three instances landed on ONE day, in three different files, each found by a different
reviewer:
- GR-T9 — `e2e/verify-scrub.sql` checked fewer columns than `scrub-template.sql` touched,
  which touched fewer than the schema held (two live Google identities shipped).
- FUP-T21 / the standing one-home rule — named two of three homes.
- PL-T2 — `CLAUDE.md`'s byte-identity line said "`amount/reference` byte-identical" while
  the spec, the backlog row and this row's own tests pin **`iban` and `revolut_username`
  equally**. Fixed by naming all four.

A narrower statement does not weaken the claim, it **launders** it: the omitted half reads
as licence. So the rule for rules — **enumerate the whole set at the point of statement, or
point at the file that is the set; never summarise it to the two examples that came to mind.**
`CLAUDE.md §Documentation discipline` already says this for guards and greps; it applies to
every invariant, and the giveaway is a rule whose sentence is shorter than the test that
enforces it.

**The other two minors.** (a) `CycleDetail.vue`'s receivables + refund lines rendered the
„VS … · " prefix UNCONDITIONALLY while the two row sites added in the same row guarded on
truthiness — unreachable today, but two conventions for one value in one diff is how the
next person picks the wrong one. Both card lines now carry the same
`v-if="row.variable_symbol"` guard, so an empty (refused) symbol never renders a bare label
and a dangling separator. (b) `payment-links.spec.js`'s header still claimed the file "pins
two things only" and that the VS "is not in any response yet" — a claim its own 544 new
lines disproved. Rewritten as a four-item table of contents, with a pointer to
`guest-order-recovery.spec.js` for the mail half. ⚠ A file header is documentation and rots
exactly like prose; the row that adds 500 lines to a file owns its header.

**Recorded, not changed.**
- ⚠ **`balancePaymentBlock()` issues a `settings` SELECT on every balance read**, and the
  friend portal hits `GET /friends/:id/balance` on each visit. Trivial against this SQLite
  file today (one indexed three-key read, synchronous, no join) and NOT worth a cache while
  the call is per-navigation. Write-down point: **if a later row makes the balance POLL**
  (a live debt banner, a dashboard refresh), that is when the settings read wants hoisting —
  and the hoist belongs in `paymentSettings()`, which is the one reader, never in a caller.
- ⚠ **A CANCELLED guest sub-order still renders its VS in the admin orders tab. That is
  INTENDED, and it is a decision, not an oversight.** The refund queue quotes the very same
  symbol (`variable_symbol` is on the `refunds` rows too), and a cancelled-but-paid order is
  exactly the row the admin is matching money BACK against — so the two surfaces would
  disagree if the tab hid it. Contrast with the draft, which is hidden: a draft owes nothing
  and never did; a cancelled paid order owes a refund. The rule is "does this row correspond
  to money that moved or must move", not "is this row live".
- The forward-looking PL-T1 line about `payment_creditor_name` not being in
  `e2e/scrub-template.sql` is still literally true — left as it stands.

---

## PL-T3 — `lib/payment-links.js`, the PayMe bar and the VS row (2026-09-19)

**What shipped.** The client half of the money path: one module that turns a server
`payment` block into links, and the shared Platba modal wired to it. No backend change,
no new dependency (`@vueuse/core` was already installed and pre-approved).

`frontend/src/lib/payment-links.js` exports exactly four names (pinned):

| Export | Contract |
|---|---|
| `REVOLUT_AMOUNT_LINK` | `true`. Flipping it to `false` makes `revolutLink()` return the plain profile link for every amount and drops the amount from the modal's label — ONE line, ONE place |
| `revolutLink(username, amount)` | `@` stripped, trimmed, `encodeURIComponent`'d. `https://revolut.me/<u>?amount=<minor units>&currency=EUR` when the flag is on and `Number.isFinite(amount) && amount > 0`; the shipped profile link otherwise; `''` for a blank handle |
| `paymeLink({iban, amount, variableSymbol, reference, creditorName, date})` | `''` unless IBAN + creditor name + a positive amount. `https://payme.sk/?V=1&IBAN=…&AM=…&CC=EUR&DT=…[&PI=/VS…/SS/KS][&MSG=…]&CN=…`, IBAN whitespace-free + upper-cased, `MSG` capped at 140, `DT` = today |
| `payBySquarePayload({…})` | the shipped bysquare object with EXACTLY two fields changed: `variableSymbol` and `beneficiary.name = creditorName \|\| 'Gorifi'` |

**The hand-off PL-T1 wrote down is discharged, and the assertion that discharges it is
not the obvious one.** The creditor name is validated for LENGTH ONLY, so `&`, `#`, `+`,
`%` and a newline all reach this file. Every value that enters a URL goes through
`encodeURIComponent` — but a test that only reads the value back
(`new URL(href).searchParams.get('CN')`) **passes against a raw interpolation** whenever
the fixture happens to contain no `&`. So the fixture carries one
(`'A & B #1 +50% =x\nKaviareň'`) and the test asserts the **parameter KEY SET**:
`['V','IBAN','AM','CC','DT','PI','MSG','CN']`, exactly eight. A raw `CN=${name}` grows a
ninth and fails; the `#` is caught by asserting `url.hash === ''`. **Proven by mutation,
not by reading:** reverting the encode to a raw interpolation and re-running turned both
encoding tests red with `raw interpolation would invent parameters`. Same technique
covers the Revolut handle (a space + `&` + `#` in the username).

**The `REVOLUT_AMOUNT_LINK=false` fallback is proven by actually flipping it.** The spec
promises "one line, one place" for the case where Revolut's `?amount=` format does not
prefill on a real phone. A test that read the constant would prove nothing about what
flipping it does, so the spec copies `payment-links.js` + `money.js` into an
`os.tmpdir()` directory with a **`node_modules` symlink** to the frontend's (so `bysquare`
resolves), substitutes the one line, imports the copy and asserts the plain profile link —
with a non-vacuity gate that the needle appears exactly once in the source. Nothing is
written into the repo: a probe file left under `frontend/src/lib/` would be a second home
for the module, which is the one thing §UC-PL-004 exists to prevent.

**⚠ The relative `./money.js` import is a testability decision, not a slip.** Every other
consumer writes `@/lib/money`. Without the Vite alias this module is importable by a plain
`node` process, which is what lets the spec drive the three builders over inputs no HTTP
fixture can produce. The alias would have bought nothing and cost that.

**A FOURTH edit to `guest-payment-modal.spec.js`, FORCED rather than planned — and the
class of trap it belongs to.** The backlog sanctioned three edits (the `independentQr`
signature, the `:366` href, new tests). §UC-PL-006 item 2 puts a second
`label.field-lbl` („Variabilný symbol") in the reference section, and the shipped
anatomy test asserts `expect(d.locator('.field-lbl')).toHaveText('Poznámka…')` — a
**strict-mode violation** the moment a second one renders, because `toHaveText` with a
STRING requires exactly one match. Retargeted to the array form, which pins both labels
AND their order: strictly more than what it pinned before. ⚠ The general lesson:
**an unscoped class locator with a single-string `toHaveText` is a landmine for the next
row that adds a sibling** — it fails with a strict-mode error that looks nothing like the
feature that caused it.

**The PayMe bar is `v-if`, and the shipped `.m-body` order pin is what makes that
mandatory.** `guest-payment-modal.spec.js` maps `.m-body`'s children by TAG
(`c.tagName === 'A' ? 'revolut'`), so an `<a>` present-but-hidden by CSS on desktop counts
as a **second Revolut bar** and reddens a shipped assertion for nothing. Confirmed by
mutation: dropping the `coarsePointer` half of the gate turned BOTH the new desktop
absence test and that shipped anatomy test red. The new touch tests use their own
testid-aware mapper.

**`pointer: coarse` emulation works, and the recipe is `ios-input-zoom.spec.js`'s.**
`const { defaultBrowserType, ...IPHONE } = devices['iPhone 13']` + `test.use({ ...IPHONE,
viewport: PHONE })`; `defaultBrowserType` MUST be stripped (it carries `'webkit'` and
setting it inside a describe is a hard Playwright error). Every touch test reads
`matchMedia('(pointer: coarse)').matches` back as a non-vacuity gate — both halves of this
feature ("the button is there" / "the button is absent") are one emulation failure away
from being meaningless. The recorded fallback gate `(pointer: coarse), (hover: none)` was
NOT needed.

**Hermetic negative cases through `page.route`, never a settings PUT.** "No creditor name
⇒ no PayMe and the QR says Gorifi" and "no VS ⇒ no row and a VS-less QR" are driven by
intercepting the status response and blanking ONE field, reusing the file's shipped
`iban: 123456` idiom. Mutating the global `payment_creditor_name` would have left the
instance blank on any crash and raced every other file in the batch.

**Kept byte-identical on purpose.** `payBySquarePayload` calls `iban.replace(/\s/g,'')`
on the RAW value: a non-string `iban` must still THROW, because that is the only lever the
network offers on the caller's catch arm, and the shipped error copy („Nepodarilo sa
vygenerovat QR kod.") must paint instead of an empty 190×190 ink frame that reads as "scan
me". Pinned in the child probe as well as through the UI. Likewise the friend cart-bar
modal (`FriendOrder.vue` untouched, PL-T4's row) passes neither new prop, so its payload
is `variableSymbol: ''` / `beneficiary "Gorifi"` — which is what keeps
`money-rounding.spec.js`'s hard-coded `'Gorifi'` valid and let that file run UNMODIFIED.

**D4 discipline — the three struck claims.** "FROZEN props" was stated in three places and
is struck (never deleted) with a pointer in all three: `06 §UC-GX-005`, `PaymentModal.vue`'s
header and `15-payment-links.md`'s header.

⚠ **THERE WERE SIX COPIES, NOT THREE — and "it lives in another module's file" is NOT a
reason to leave a false claim standing.** The implementer struck the three the row named
and left `18-portal-information-architecture.md:24` and `:1076` and
`20-guest-packeta.md:300` ("`PaymentModal.vue` | no change — props frozen"), reasoning that
they are a FUTURE module's rationale and out of a module-15 row's scope. **The orchestrator
overruled that, correctly, and all six are struck now.** The reasoning to keep:

- `CLAUDE.md §Documentation discipline` says EVERY copy, and this is the exact situation the
  rule is for — the two rows that will read those lines (PI-T7, GP-T1) are precisely the
  ones who would act on them.
- A strike + pointer changes **no requirement and no acceptance criterion** of modules 18
  and 20, so it is not an edit to their scope. It only stops a future reader trusting
  something this row made untrue.
- Same shape as the friend-portal label that survived a whole module, and the **third**
  instance on this day (see the PL-T2 review follow-up: a rule written narrower than the
  thing it protects).

**Find the copies by grep, never from a list.** `grep -rn "frozen" docs/specification
frontend/src e2e` is what turns three into six; a mental inventory does not. Each strike
also states what "frozen" still protects (a prop that REPLACES or reshapes an existing one
breaks four screens at once), so the pointer carries the surviving half of the claim rather
than only deleting the dead half.

**Testing notes worth reusing.**
- The admin-boundary sweep reads the admin view set **off `router.js`** (every `/admin/...`
  path's lazy `import('./views/X.vue')`) instead of a hand-kept list, so a new admin screen
  joins the sweep the day it is routed. Non-vacuity: more than 8 admin routes parsed, and
  `PaymentModal.vue` really does import the module (else the sweep is a tautology over a
  file nobody imports).
- The VS copy row is verified by READING THE CLIPBOARD (`grantPermissions(['clipboard-read',
  'clipboard-write'])` + `navigator.clipboard.readText()`), not by the label flip —
  `NeoCopyRow` flips green whether or not the write succeeded, by design.

**Verified (2026-09-19, per-run copy of `e2e/fixtures/prod-template.sqlite`, frontend
rebuilt into `backend/public`, `--workers=1`):** `guest-payment-modal` + `payment-links`
**76 passed**; `guest-payment-modal` / `guest-order` / `guest-status` / `payment-links` /
`money-rounding` **140 passed, 0 skipped**; `order-modals` / `guest-lead-capture` /
`self-hosted-fonts` / `guest-status-shell` / `guest-order-shell` / `guest-order-recovery`
**191 passed**. `vite build` green; `node --check` on both spec files.

**⚠ THREE ITEMS ARE PO VERIFICATION, NOT GATES — none is automatable here.**
1. **Revolut `?amount=<minor>&currency=EUR` on a real phone with the Revolut app.** If it
   does not prefill, flip `REVOLUT_AMOUNT_LINK` to `false` — one line, and the label loses
   its amount with it (the label is derived from the href, so there is no second switch).
2. **The real PayMe field caps.** `CN` is the ISO/SEPA 70 (`MAX_CREDITOR_NAME_LENGTH`,
   server-side) and `MSG` is 140 (`MAX_PAYME_MESSAGE_LENGTH`, client-side) — both are
   defensible defaults, NOT verified quotes: the SBA Payment Link Standard PDF is still not
   text-extractable and payme.sk states no caps. Each is one constant with one home.
3. **How a real bank app parses `PI=/VS…/SS/KS`** (added by the PL-T3 review). It now ships
   with BARE structural slashes and an encoded symbol. Nothing here can settle whether a
   given app URL-decodes the query or splits it raw — a phone can. If an app is found that
   requires the escaped form, the change is one line in `paymeLink()` **and** the two raw
   pins that exist precisely to make it visible (`payment-links.spec.js`'s `PI=` segment
   assertions and `guest-payment-modal.spec.js`'s rendered-href one).

### PL-T3 review follow-ups (2026-09-19, approve + 4 minors — all fixed in the same commit)

**⚠ THE REAL FINDING: „encode everything" IS NOT THE RULE. ENCODE VALUES, NEVER
STRUCTURE.** `paymeLink()` put the whole payment-identification triplet through
`encodeURIComponent`, emitting `PI=%2FVS9000123%2FSS%2FKS`. `/` is legal unencoded in a
query string, §UC-PL-006 and the published PayMe examples write the parameter literally,
and a receiving bank app that splits the RAW query instead of decoding it reads the escaped
form verbatim — a malformed identifier on **the one field that makes a bank statement match
a person**. Over-encoding failed in the same place under-encoding would have.

⚠ **And NEITHER of the row's own tests could see it**, which is the transferable half: the
parsed assertion (`new URL(...).searchParams.get('PI')`) **decodes**, so the two forms are
indistinguishable to it, and the raw-string pin had the encoded form baked into its
expectation. **A round-trip assertion cannot audit a wire format.** Fixed by pinning the
RAW `PI=` segment character-for-character in both specs, plus a new case proving the
converse still holds — a symbol carrying `/`, `&` and `#` is still encoded, so it can
forge no triplet, invent no parameter and open no fragment.

**Two "can't happen from today's callers" gaps, both closed by DERIVING instead of
re-testing.** The lesson is the same in both: when two things must agree, compute one from
the other rather than writing the predicate twice.
- The Revolut **label** used `REVOLUT_AMOUNT_LINK && props.amount` (truthiness) while the
  **link** used `Number.isFinite(amount) && amount > 0`, so a negative or infinite amount
  would have shown a sum in the button over an href carrying none. Unreachable from today's
  three non-negative payloads — and this component gains the BALANCE caller in PL-T4 and
  the landing debt banner in module 18. Now the label is derived from the href
  (`revolutHref.includes('?amount=')`), which also makes the `REVOLUT_AMOUNT_LINK` fallback
  automatic and removes the constant from the component entirely.
- The Revolut **render gate** was still the shipped `v-if="revolutUsername"` while the href
  came from the builder, which returns `''` for a whitespace-only handle — and `PUT
  /settings` trims only the creditor name. So a handle of spaces rendered `href=""`, which
  is a link to the CURRENT URL: clicking it **reloads the page**, and on g-confirm that
  discards the confirmation state (its payment data comes only from the submit response).
  The shipped code's broken external link was at least honest; an empty href is
  destructive. Now every control is gated on its own composed value (`revolutHref`,
  `paymeHref`), never on the raw prop it was built from.

**Recorded, not changed.**
- ⚠ `01-architecture.md:221` and `:264` describe the deep-link composition as living in
  `PaymentModal.vue`. Half true since this row: the two LIBRARY CALLS stayed in the
  component (the error handling around them is its UI), while the payload and the link
  composition moved to `lib/payment-links.js` (D6 pre-resolves the reading, and one of
  those lines was already imprecise before this row). **For the module-15 closeout.**
- ⚠ The VS copy row sits INSIDE the reference block, so a payload carrying a symbol but no
  reference renders no row. Correct today — every server composer emits both together — and
  worth remembering if a surface ever ships a reference-less payment block.

**Left for PL-T4.** `FriendOrder.vue` (both the `PaymentModal` mount's two new props and
the success modal re-pointed at `payBySquarePayload`/`revolutLink`), the balance
„Zaplatiť" trigger + mount on `FriendBalanceCard.vue`, and the sanctioned
`money-rounding.spec.js` `independentQr` edit. ⚠ The success modal gets NO PayMe bar and
NO VS row (§UC-PL-007 item 1) — the full payment surface is „Zaplatiť“ → `PaymentModal`.

---

## PL-T4 — the friend surfaces, the balance „Zaplatiť“, and the module-15 closeout (2026-09-19)

**What shipped.** No server change at all: every value on screen was already in a payload
(`friendOrderPayment()` from PL-T2, `balancePaymentBlock()` from PL-T1/T2). This row is
three client edits and one sanctioned spec edit.

| File | Change |
|---|---|
| `frontend/src/views/FriendOrder.vue` | `paymentCreditorName` + `paymentVs` refs; `applyOrderPayment(response)` quotes `payment.variable_symbol` off the GET, the PUT and the submit; the `PaymentModal` mount gains the two props; `generateSuccessQr()` re-pointed at `payBySquarePayload()`; the success modal's Revolut `<a>` re-pointed at `revolutLink()` with the amount-suffixed label |
| `frontend/src/components/FriendBalanceCard.vue` | `payment` + `showPayment` refs, the `canPayBalance` gate, the „Zaplatiť“ trigger (`data-testid="pay-balance"`, `.btn.ok.sm`, BEFORE „Transakcie“) and the `PaymentModal` mount |
| `frontend/src/components/PaymentModal.vue` | header only — the fourth caller is real now, and the module-18 "relocated, never duplicated" rule is stated where the component is read |
| `e2e/helpers/qr-pixels.js` (NEW) | `readQrModules()` / `qrMatrix()` — the pixel-QR technique, lifted out of the specs (§UC-PL-009 item 7) |
| `e2e/tests/payment-links.spec.js` | +7 tests in two describes (§UC-PL-007 items 1 and 4) |
| `e2e/tests/money-rounding.spec.js` | THE sanctioned edit (§UC-PL-009 item 2) |

**The sanctioned edit, exactly as scoped.** `independentQr()` takes a `variableSymbol`
parameter (`String(order.id)` at all three call sites — `cart()` already returned the
order, the tests simply discarded it) and `beneficiary` STAYS `'Gorifi'`, because
`primePage()`'s `payment-settings` mock carries no creditor name and D3 makes
`creditorName || 'Gorifi'` the fallback. That absence is now also what the file proves.
Nothing about the drifting-vs-rounded amount logic moved. `order-modals.spec.js:877/:881`
passed unmodified, as the row required: the name lookup matches substrings and
`^https://revolut\.me/` is compatible with a query string.

**Where the VS comes from on the friend order screen, and why it is a ref and not a
computed.** The obvious shortcut is `computed(() => String(order.value?.id ?? ''))` — the
scheme is literally the order id. That would be a SECOND HOME for the derivation, in the
one module whose entire purpose is that there is one. `applyOrderPayment()` quotes the
server's `payment` block instead, from whichever response arrived last, so the day the
scheme changes (a prefix, a padding, a check digit) `helpers/payment.js` is still the only
file that knows. The `payment: null` case (no order yet, or a PUT that emptied the cart and
deleted the row) falls out for free as `''` — which renders the VS-less modal rather than
a made-up symbol.

**⚠ THE BALANCE CARD CLEARS `payment` BEFORE EVERY READ — defence in depth, and the
rationale has to be stated precisely because the obvious one is BACKWARDS.** The first
draft of this comment said the card survives a logout because `FriendPortalSession` is
kept alive by `v-show`. It is the opposite, and the opposite is load-bearing:
`FriendPortal.vue:1581` mounts the session with `v-else-if="authState === 'authenticated'"`
plus `:key="sessionSeq"`, and `FriendPortalSession.vue:36-41` says in as many words that
the parent's `v-if` (NOT `v-show`) is what holds the boundary — "swapping it for `v-show`
keeps this instance alive across a logout and every one of the six leaks comes back at
once". So the card is DESTROYED on logout and re-created with `payment` at `null`;
cross-session leakage is structural, not this clear's job. ⚠ A comment claiming otherwise
is worse than no comment: it describes the exact refactor the codebase warns against, sat
next to the rule it would break, where the next reader reaching for `v-show` would read it
as confirmation. Caught in review — the lesson is the same one this module keeps
re-learning: **verify the claim in the file that owns it, do not infer the mechanism from
the symptom you are defending against.**

What the clear actually buys is two narrower things, both real: an IN-PLACE `friendId`
change (the card's own `watch`, which no path reaches today — the same standing the
parent's `:key` has) would otherwise re-point the card at a new friend with the previous
one's symbol, reference and amount still mounted and openable; and a FAILED reload would
otherwise paint the error banner with a stale block sitting behind a „Zaplatiť“ that still
opens. `showPayment` is cleared with it: a dialog quoting a debt that is no longer on
screen has no owner.

**The trigger is gated on the composed block, never on the balance alone.**
`canPayBalance = balanceState === 'neg' && payment && (payment.iban ||
payment.revolut_username)`. Three consequences worth keeping: a settled friend or one in
credit is offered nothing (the server already answers `amount: 0` there); an instance with
no payment block — which is exactly what `portal-transactions-modal.spec.js` stubs, and
that file must keep passing byte-unmodified — renders precisely the shipped card; and the
control and the modal can never disagree, because the modal is opened with the same object
the gate read.

**No reload on close, deliberately.** Paying through a Revolut/PayMe link or a QR changes
NOTHING in the ledger until the admin records the transfer (`paid` is admin-only, module
15 writes no `transactions` row anywhere). A `loadBalance()` on close would redraw the same
debt and read as "the payment did not go through", or — worse, one day — as "it did". The
e2e test counts the `/balance` requests around three open/close cycles and pins ONE.

**The success modal is a confirmation with a shortcut, not the payment surface.** It gains
the symbol INSIDE its QR and an amount-prefilled Revolut link, and it gains neither the VS
copy row nor the PayMe bar (§UC-PL-007 item 1). The rule 04 already had for the reference —
"one home for the string the friend must type into their bank" — now covers the variable
symbol too: both live in the Platba modal that the cart bar's „Zaplatiť“ opens. The
absence is pinned with a non-vacuity gate: the same test then re-enters the cycle, opens
„Zaplatiť“ and reads the VS row off the full surface.

**Both friend controls are gated on their own composed href.** `successRevolutHref` repeats
what PL-T3 did inside `PaymentModal`: the shipped `v-if="paymentRevolutUsername"` over a
builder-composed href would render `href=""` for a whitespace-only handle — a link to the
CURRENT URL, i.e. a page reload — and the amount label reads the href rather than the
amount, so the `REVOLUT_AMOUNT_LINK` fallback has no second place to remember.

**Testing notes that cost time.**
- `getByTestId('payment-vs')` is `NeoCopyRow`'s ROOT, and its text includes the copy
  button's label: an assertion reads „240Kopírovať“. Assert on `.locator('.val')` — the
  idiom `guest-payment-modal.spec.js:904` already uses.
- `payment-links.spec.js` loads `bysquare`/`qrcode` from the frontend tree DYNAMICALLY,
  unlike `money-rounding.spec.js`'s static cross-tree import: this file also runs against a
  deployment, where a static import would fail the WHOLE file to load and take the
  API-level sections with it. The QR tests `test.skip(!CAN_IMPORT_LINKS)` instead.
- The PL-T4 fixtures call `loginApi()` first. The §UC-PL-008 block above them signs in
  through the BROWSER, which mints a new app-wide admin session and kills the API
  context's token — the file header's ordering note, met in practice.
- ⚠ The red run is worth the two minutes it costs. Stashing the two `.vue` files and
  rebuilding gave 8 red / 2 green: the 2 green are the "no button when settled / when the
  payload carries no block" tests, which SHOULD pass before and after (they pin shipped
  behaviour), and both carry a non-vacuity gate on the card actually being on screen.

**Recorded, closed.** PL-T3 left `01-architecture.md:221`/`:264` ("Pay by Square QR …
inside `PaymentModal.vue`", "pure URL composition in `PaymentModal.vue`") for this
closeout. Both are now struck and rewritten to name `lib/payment-links.js`, with the
original reading kept as ~~strike~~ + pointer.

**Left open for module 18 (PI-T7), stated in three places (the card, `PaymentModal`'s
header and the backlog row).** The trigger and the mount RELOCATE into „Zostatok a platby“
and the landing debt banner. There must never be a SECOND `PaymentModal` for the balance —
if the banner links to payment, it opens this one.

**Left open for module 21.** Messages quote `helpers/payment.js`'s symbol and never
re-derive one; the note is on the balance card, where a reader composing a debt message
will be looking.

**The module-15 closeout run, and the two things it taught about the harness.**
`1841 passed / 1 failed / 26 skipped / 11.8 min` on a per-run copy of
`e2e/fixtures/prod-template.sqlite` with a rebuilt frontend in `backend/public`.

- ⚠ **The FIRST full run reported 16 failed and 108 „did not run“, and every one of them
  was a lie.** All sixteen were `429` on `admin login`, most inside a `beforeAll` — which
  is what turns 16 failures into 108 tests that never ran. The suite is ~1870 tests now and
  the README's recommended `RATE_LIMIT_AUTH_MAX=1000` is no longer enough for one pass: the
  shared `authLimiter` bucket exhausted around test ~1700, so the TAIL of the suite
  collapsed and read as a broad regression in whatever had just been changed. Re-run with
  all five maxima at `100000`: the numbers above. The README now carries the measurement.
- ⚠ **21 of the 26 skips were silent, and avoidable.** The FUP-T7/T10/T11/T12/T13/T14/T15
  "no stack reaches the log" families are gated on `SERVER_LOG=<backend log path>`, which
  the recipe never set. Spot-checked with it exported: they run and pass. The README's run
  command now sets it. The genuine remainder is four: the three limiter specs (which skip
  BECAUSE the maxima are raised — the documented trade) and `forced-change-ui.spec.js`
  (`test.fixme`, its own radix-Select reason).
- ⚠ **The one real failure is DATA, and it is not this row's.**
  `admin-friends-labels.spec.js:119` sweeps the whole rendered friends list for
  `/prihlasovac/i`. GR-T9's freshly rebuilt template carries a real production friend row —
  `id 72, name 'Prihlasovacie.meno'`, and names are KEPT by PO decision — so the sweep can
  never pass against this template. It reproduces on the file alone and has nothing to do
  with module 15. Left untouched and reported: the guard is right, the fixture is what
  changed under it. Whoever picks it up chooses between scoping the sweep to the page's own
  COPY (excluding friend-authored fields) and scrubbing that one name.
