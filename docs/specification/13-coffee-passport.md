# 13 — Coffee passport (brew methods, Moje kávy, micro-reviews, product detail modal)

> ## ⛔ STATUS: DEFERRED — entire module (PM decision 2026-08-22)
> The product owner deferred the whole passport concept ("I'm not sure about it now").
> **No UC in this file may be planned or built.** `/plan-backlog` must not emit rows for
> this module. The spec is kept as drafted (including the 2026-08-22 amendments:
> chips removed, brew-method mapping confirmed) so the work is not lost if the module
> is revived. Module 12 ships alone; its forward seams to this module (the S12-merge
> review-repoint obligation, migration-before-13 sequencing) bind only if this module
> is ever un-deferred.

> Scope: The friend-facing layer on top of module 12's consolidated catalog: the
> `friend_brew_methods` junction + friend-owned routes + the multi-select "Ako
> pripravujete kávu?" question in the profile modal, the multi-select semantics on the
> order page (purpose-tab defaulting, roast-purpose mismatch hint), 👍/😐/👎
> micro-reviews (`friend_reviews`, upsert latest-wins), the passport screen "Moje kávy"
> (header stats, cross-cycle history, inline rating, "Objednať znova"), the friend-facing
> catalog read endpoint (display field set only), and the product detail modal
> (photo + Región/Nadmorská výška/Farma/Odroda kávy/Spracovanie).
> ⚠ Like 07–12 this module INCLUDES backend/schema changes (00-overview §Scope
> extension 2026-08-22). Out of scope (handoffs): the `coffee_products` schema, import
> consolidation, migration/backfill, merge tool, admin catalog UI and cross-cycle admin
> stats → **module 12** (consumed here via the named seams in §Module-12 seams);
> social-proof badges/labels of ANY kind — aggregate AND named — deferred, internal data
> only (brief §4.1/Decision 4); the beginner recommendation flow "Pomôž mi vybrať", year
> recap, exploration badges, referral-credit display → **module 14** (the passport
> header STATS are in scope here; BADGES derived from them are not); tier progress on
> the order page → **cut entirely** (brief Decision 7 — not deferred, removed); guests —
> every guest surface is untouched: no passport, no reviews, no detail modal,
> `GuestProductGrid.vue` keeps the plain photo lightbox; the importer — byte-identical
> per module 12.
> Actors: **Friend** — the only actor on every surface here; all writes are
> Bearer + ownership-guarded, all copy vy-form. **Admin** — context only: enters the
> catalog attributes in module 12; has no surface in this
> module and no route here is admin-guarded. **Guest** — never sees any of this.
> Sources: `docs/requirements/2026-08-18-catalog-profiles-recommendations-brief.md`
> (v5 — §3 Module 2 is this module's brief; §6 Decisions 7/8/9 win over earlier body
> text), `docs/specification/00-overview.md` (§Scope extension 2026-08-22, glossary:
> Passport, Micro-review — binding; its Flavor-chips entry is superseded by the
> 2026-08-22 chips deferral, PM), `docs/specification/01-architecture.md`
> (§Catalog & passport extensions — `friend_brew_methods`/`friend_reviews` shapes,
> multi-select semantics, never-a-transactions-row, ownership guards; §Frontend
> structure sequencing conventions; §i18n), repo code (`backend/src/routes/subscriptions.js`
> — the junction-route template, `backend/src/middleware/friend-auth.js`,
> `backend/src/helpers/analytics.js` — `computeStreak`/`variantToKg`,
> `frontend/src/views/FriendPortalSession.vue`, `frontend/src/views/FriendOrder.vue`,
> `frontend/src/components/ProductImageModal.vue`, `frontend/src/lib/purposes.js`,
> `frontend/src/lib/plural.js`, `frontend/src/api.js`, `frontend/src/router.js`),
> repo `CLAUDE.md` (`.app > *` rule, `ready` gate, kg-formatting rule, FUP-T20 label
> guard, locator-owning specs). The most recent decision wins on conflict.
> **Design reference:** no prototype screen exists for this module (the 07 precedent).
> The passport screen and every new element compose from shipped Podpultovka precedents:
> `.card`/`.badge`/`.sub`/`.mono` per module 02, the portal cycle card
> (`FriendPortalSession.vue`) for list rows, `NeoModal` for the detail modal, the
> subscription modal's checkbox primitive for the multi-select. Visual sign-off happens
> on staging, not against a raster.

---

## Resolved conflicts / recorded decisions (recency / canonicity)

1. **The product detail modal EXTENDS `ProductImageModal.vue` — no sibling component.**
   The component's own header comment is a standing pin: "ONE HOME, TWO CALL SITES …
   Extend this component; never inline a second copy." A sibling `ProductDetailModal`
   reusing `NeoModal` would be a fork by construction — two modals rendering the same
   photo with drifting rules (the exact divergence 06 §UC-GX-002 exists to prevent).
   Resolution: `ProductImageModal` gains an **optional** `details` payload (UC-CP-008);
   absent ⇒ byte-identical behavior, so the two guest call sites are untouched without
   being edited.
2. **"Objednať znova" navigates and focuses — it NEVER writes to the cart.** The brief
   says only "when that catalog product is in an open cycle". A silent cart write would
   (a) have to guess a variant (250g? 1kg? — the catalog has no "default variant"
   concept), and (b) on a friend with a *submitted* order it would manufacture the
   orange unsaved-changes state without the friend touching anything (CLAUDE.md
   auto-save rules). Resolution: navigate to the order page with the product focused
   (UC-CP-013); the friend picks the variant themselves.
3. **Micro-reviews require a purchase.** The brief's philosophy is "data-first: derived
   from orders, corrected by micro-reviews" and the passport — which lists only ordered
   coffees — is the ONLY review surface. The write endpoint enforces it (400 when the
   friend has no submitted order item linked to that catalog product) so the invariant
   holds server-side, not just by UI reachability.
4. **Flavor chips are DEFERRED entirely (PM, 2026-08-22 — supersedes the brief's §3
   chips paragraph).** The PM judged the chips risky as a friend-facing signal
   (potentially misleading); module 12 is dropping the `flavor_chips` column and the
   keyword auto-tagger with the same decision. Consequence for this module: **nothing
   in v1 may reference the column** — no chips on the detail modal, none in any
   payload, none in the passport. Chips (display AND storage/derivation) return only
   with a future module, if at all.
5. **The passport is its OWN route (`/passport`), entered from a portal card** — not a
   section inlined into the portal. The portal (`FriendPortalSession.vue`) is already
   the app's densest screen (balance, vouchers, cycles, archive, 4 modals); the brief
   calls the passport a "screen". A route also gives module 14 a stable entry point.
6. **Passport rows carry NO product image.** `products.image`/`coffee_products.image`
   are `data:` URIs today; the 13 MB-JSON payload finding (CLAUDE.md, 2026-08-20) rides
   on the planned consolidation. A history list of N coffees × a base64 photo each is
   that bug re-shipped. Rows are text; the photo lives in the detail modal on the order
   page.
7. **First-ask moment = the passport empty/unanswered state, inline — no portal banner,
   no modal, no nag.** The question renders as a card at the top of `/passport`
   whenever the friend has zero stored methods, and disappears once answered
   (UC-CP-011). It is permanently editable in "Upraviť profil" (UC-CP-004). A
   dismissible portal-level prompt was considered and dropped — the portal already
   carries a pending-voucher modal and (admin-side precedent) an amber banner; a second
   ask-surface is nagging. `OPEN:` if the product owner wants the question pushed more
   aggressively (e.g. a one-time portal prompt), that is a product-level addition — not
   drafted here.
8. **Method→purpose mapping — CONFIRMED product decision (PM, 2026-08-22), one home**
   (UC-CP-002): `espresso → Espresso`, `moka → Espresso`, `filter → Filter`,
   `frenchpress → Filter`, `capsules → Kapsule`. The brief names the five methods and
   the three purposes but never states the mapping; the `moka → Espresso` and
   `frenchpress → Filter` rows were proposed in this spec and confirmed by the product
   owner 2026-08-22. Not open — a change to this constant is a product decision.
9. **Streak cycle ordering carries an id tiebreak.** `computeStreak` is reused verbatim
   (one home, `helpers/analytics.js`), but the passport endpoint orders its cycle list
   `created_at ASC, id ASC` — the GSO-T8 second-resolution-timestamp lesson.
   (`analytics.js:28`'s own missing tiebreak is a recorded follow-up there; this module
   must not inherit it.)
10. **"objednané N×" counts DISTINCT CYCLES**, not order lines. Two bags of the same
    coffee in one cycle is one buying decision; N× across cycles is the repeat-buy
    signal the passport (and module 14's ranking seam) cares about. Matches module 12's
    repeat-buyer convention (distinct friends with the product in ≥2 cycles).

---

## Module-12 seams (consumed, never re-specified)

| Seam | What 13 consumes | What 13 must NOT do |
|---|---|---|
| **S12-catalog** (12 UC-PC-001/009) | `coffee_products` exists with `country`, `region`, `altitude`, `farm`, `variety`, `processing`, `purpose`, `name`, `status` (01-architecture §Catalog extensions — its column list already reflects the 2026-08-22 chips deferral, resolved decision #4). | Never write to it; never expose non-display fields to friends (prices, `normalized_name`, `status`, `curator_pick_note`, `is_new` stay unpublished here). |
| **S12-link** (12 UC-PC-001; populated by UC-PC-003, backfilled by UC-PC-006) | `products.source_coffee_product_id` — populated by the import layer for new cycles and backfilled by the one-time migration for history. Every passport join runs through it. | Never join `order_items` to the catalog any other way; never "fix" an unlinked snapshot (a NULL link simply doesn't count — see UC-CP-010 edge case). |
| **S12-stats** (12 UC-PC-010) | The repeat-buyer/window stats conventions (per-purpose, windowable) power module 14's internal ranking — NOT consumed in this module. Named so the orchestrator can verify 12 provides them. | No 13 surface may render them (that would be a social-proof badge — deferred). |
| **S12-merge** (12 UC-PC-007) | The catalog merge tool repoints snapshot links inside one transaction. | ⚠ **OBLIGATION, recorded on both sides:** the task that lands `friend_reviews` (UC-CP-001) MUST extend UC-PC-007's merge transaction with a review repoint — `friend_reviews.coffee_product_id` B→A with latest-wins dedupe on the UNIQUE(friend_id, coffee_product_id) pair (two reviews of A and B by the same friend collapse to the newer verdict). Without it a merge strands or crashes on reviews. |

**Sequencing dependency, explicit:** the passport is empty until S12-link is populated.
Deploying 13 before 12's migration ran yields a truthful "zatiaľ prázdny" passport for
everyone — degraded, not broken. The backlog must order 12's migration before 13's
passport rows are considered verifiable against real history.

---

## UC-CP-001 Schema — `friend_brew_methods` + `friend_reviews` (system)

**Goal:** the two module tables in `backend/src/db/schema.js`, per 01-architecture
§Catalog & passport extensions (binding shapes).

**Business rules:**

- `CREATE TABLE IF NOT EXISTS friend_brew_methods (friend_id INTEGER NOT NULL,
  method TEXT NOT NULL, UNIQUE(friend_id, method))` — the `friend_subscriptions`
  pattern, byte-for-byte in spirit. Valid methods (the enum, validated at the route,
  not by CHECK — the repo convention): `espresso`, `moka`, `filter`, `frenchpress`,
  `capsules`.
- `CREATE TABLE IF NOT EXISTS friend_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT,
  friend_id INTEGER NOT NULL, coffee_product_id INTEGER NOT NULL, verdict TEXT NOT NULL,
  brew_method TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(friend_id, coffee_product_id))`. Verdict ∈ `up`/`mid`/`down`. `brew_method`
  nullable, same enum as above.
- Both are NEW tables (`CREATE TABLE IF NOT EXISTS`) — no try/catch `ALTER TABLE`
  needed and no change to any existing table. Module 12 owns the one existing-table
  change (`products.source_coffee_product_id`, S12-link).
- No FKs (the repo's bare-table pattern): a hard-deleted friend leaves rows behind.
  Read-side tolerance per the GSO-T9 precedent — every consumer joins through
  `friends`/`coffee_products` anyway, so orphans are invisible; a cleanup DELETE inside
  the existing friend-delete transaction (`friends.js`, the `root_friend_id` precedent)
  is the tidy option and in scope for the implementing task.
- ⚠ **A review or brew-method write NEVER creates a `transactions` row** (01-architecture
  binding; the GSO-T6 lesson). Asserted as a zero-row check in UC-CP-014.

**Merge-tool extension (S12-merge obligation):** the same task extends 12's
UC-PC-007 merge transaction to repoint `friend_reviews.coffee_product_id` from the
merged-away product to the target, deduping on UNIQUE(friend_id, coffee_product_id)
with latest-wins. Acceptance: merging B into A where one friend reviewed both leaves
exactly one review row (the newer verdict) and zero rows referencing B.

**Acceptance criteria:** backend restart on an existing DB creates both tables
idempotently; a duplicate `(friend_id, method)` INSERT fails on the UNIQUE pair; a
second review for the same `(friend, catalog product)` cannot exist as a second row.

---

## UC-CP-002 `frontend/src/lib/brew-methods.js` — labels + method→purpose map (system)

**Goal:** ONE frontend home for everything derived from the five methods. Three
consumers (profile modal, order-page defaulting/hint, passport rating chip) — three
inline copies is how one of them ends up mapping `moka` to `Filter`.

**Business rules:**

- `export const BREW_METHODS` — fixed order, value + Slovak label:
  `espresso` → **Espresso kávovar**, `moka` → **Moka kanvička**, `filter` →
  **Filter (dripper)**, `frenchpress` → **French press**, `capsules` → **Kapsule**.
  `OPEN:` labels need product sign-off (proposed here, vy-neutral noun phrases).
- `export const METHOD_PURPOSE` — the mapping from resolved decision #8:
  `{ espresso: 'Espresso', moka: 'Espresso', filter: 'Filter', frenchpress: 'Filter',
  capsules: 'Kapsule' }`. Purpose strings match the snapshot `products.purpose`
  vocabulary exactly (`'Espresso' | 'Filter' | 'Kapsule'` — see `lib/purposes.js`
  PREFERRED). Mapping confirmed by the product owner 2026-08-22 (decision #8).
- `export function purposesForMethods(methods)` — the **UNION** of mapped purposes,
  deduplicated, order per `PREFERRED` (brief Decision 8: filter+capsules ⇒ both Filter
  and Kapsule are candidates). Empty input ⇒ empty array — **zero stored methods means
  "unknown", never "mismatch"** (UC-CP-005/006 both key on this).
- `export function defaultMethodForPurpose(methods, purpose)` — the friend's methods
  whose mapped purpose equals `purpose`; returns the single match, or `null` when zero
  or several match (never guess — the brief's own rule). Feeds the review brew chip
  (UC-CP-012).
- Backend does NOT import this file (frontend lib); the route-side enum in UC-CP-003/009
  is a local constant listing the same five values. The purpose mapping lives ONLY on
  the frontend — no backend logic keys on it in this module.

**Acceptance criteria:** covered through its consumers (UC-CP-005/006/012 e2e); a unit
runner does not exist and must not be added (01-architecture §Testing).

---

## UC-CP-003 Brew-method routes — `/api/brew-methods` (Friend)

**Goal:** friend-owned read/write of the junction, mirroring `routes/subscriptions.js`
exactly (storage AND route shape — the brief names the pattern).

**Route contract (`backend/src/routes/brew-methods.js`, mounted BARE at
`/api/brew-methods` — friend-gated per route, never wrapped in `requireAdmin`):**

- `GET /friend/:friendId` — `requireFriendOwner(req, req.params.friendId)`; on error
  `{error}` with its status. 200 `{ methods: ['espresso', …] }` (SELECT `method`).
- `PUT /friend/:friendId` — same guard. Body `{ methods: [...] }`; non-array ⇒ 400
  `{ error: 'methods musí byť pole' }`. Values filtered to the five-value enum
  (unknown strings silently dropped — the subscriptions.js posture). Write is one
  `db.transaction`: DELETE all rows for the friend, INSERT the filtered set. 200
  `{ methods: <filtered> }`. Empty array is valid (the friend un-answers the question;
  all defaulting/hinting switches off per UC-CP-002's empty rule).
- No admin variant (subscriptions has one; nothing here needs it — the admin never
  edits a friend's taste data). No new `ADMIN_ENDPOINTS` entry — there is no admin
  route in this module (recorded explicitly for UC-CP-014).
- Recorded residual, inherited from the pattern: in `auth_mode = legacy`,
  `requireFriendOwner` resolves `{friendId: null}` for bare shared-password auth
  (CLAUDE.md GA-T5 note — `subscriptions.js` shares the hole). Brew methods are
  self-correcting preference data with zero destructive weight, so the subscriptions
  posture is deliberately kept. Modern mode (the shipped portal) is fully owner-scoped.

**`api.js`:** `getBrewMethods(friendId)` / `setBrewMethods(friendId, methods)` via the
standard `request()` (Bearer attached).

**Acceptance criteria:** anonymous GET/PUT ⇒ 401; friend A's token against friend B's
id ⇒ 403; PUT `['espresso','zzz','capsules']` stores exactly
`['espresso','capsules']`; PUT `[]` empties the junction; re-PUT is idempotent.

---

## UC-CP-004 Profile modal — the multi-select question (Friend)

**Goal:** the ONE question the app ever asks directly, permanently editable in
"Upraviť profil" (`FriendPortalSession.vue`).

**Field group (inserted after the Email field group, before the Google section):**

| Element | Markup / constraints |
|---|---|
| Label | `label.field-lbl` **"Ako pripravujete kávu?"** |
| Options | one checkbox row per `BREW_METHODS` entry (fixed order), the subscription modal's checkbox primitive (module 02 — 24/32px hit target), label = the Slovak label from UC-CP-002 |
| Help | `div.field-help` **"Môžete vybrať viac možností. Pomôže nám odporúčať kávu, ktorá sedí vašej príprave."** |

**Business rules:**

- State seeded on modal open from `api.getBrewMethods(friendId)` — fire-and-forget on
  session start alongside the subscriptions fetch is acceptable, but the seed must
  follow the session-boundary rule (seeded from the hydrated handshake/fetch, never
  module-level defaults — the six-leak lesson in CLAUDE.md).
- Saved by `saveProfile()` — one additional `api.setBrewMethods` call, issued ONLY
  when the selection changed since open (the modal's existing changed-fields
  convention). A failed brew-method PUT renders in the modal's own `profileError`
  banner and leaves the modal open, exactly like a failed profile PATCH.
- Zero boxes ticked is a legal save (empty junction; see UC-CP-003).
- Copy is vy-form, no gendered participle, no placeholder text anywhere (2026-08-10
  decision).
- ⚠ The FUP-T20 grep guard (`grep -i prihlasovac` empty over this file) is untouched —
  nothing here may describe any field as a login.
- ⚠ **`portal-profile-modal.spec.js` OWNS this modal's rendered-copy sweep** — the new
  label, five option labels and help line must be ADDED to that sweep in the same
  change (e2e-immutability case (a): this UC mandates the structure change). Flagged
  again in UC-CP-014.

**Acceptance criteria:** open → tick Espresso kávovar + Kapsule → save → reopen shows
both ticked; the junction holds exactly those two rows; unticking all and saving
empties it; the copy sweep passes with the new strings registered.

---

## UC-CP-005 Order page — purpose-tab defaulting, unambiguous only (Friend)

**Goal:** `FriendOrder.vue`'s initial `activeTab` respects the friend's methods — but
ONLY when there is nothing to guess (brief Decision 8).

**Business rules:**

- Inputs: the friend's stored methods (fetched once per view behind the existing
  session restore — a new friend-authenticated fetch on this view follows the `ready`
  auth-gate timing rule) and `availablePurposes` (the existing computed — untouched).
- Let `candidates = purposesForMethods(methods) ∩ availablePurposes`.
  **Default `activeTab` to `candidates[0]` if and only if `candidates.length === 1`.**
  This covers both sanctioned cases in one predicate: a single method, and multiple
  methods that all map to one purpose (espresso+moka ⇒ Espresso).
- `candidates.length === 0` (no methods stored, or nothing matching this cycle) or
  `≥ 2` ⇒ the shipped behavior is untouched: first available purpose wins
  (`watch(availablePurposes)` at `FriendOrder.vue:458`). **Never guess between two.**
- The default applies ONLY before the friend has interacted: once the friend taps a
  tab, nothing re-defaults (no watcher may move `activeTab` after a user action —
  extend the existing watch's predicate, don't add a competing one).
- A `?product=` deep link (UC-CP-013) OVERRIDES this default — explicit intent wins.
- Bakery cycles: untouched (no purposes to map).
- Failure posture: the brew-methods fetch failing (or legacy `friendId: null` auth)
  degrades silently to the shipped default — the feature is an optimization, never a
  gate on rendering products.

**Acceptance criteria:** friend with `['capsules']` opening a 3-purpose coffee cycle
lands on Kapsule; friend with `['filter','capsules']` lands on the shipped first tab
(Espresso, when present); friend with `['espresso','moka']` lands on Espresso; friend
with no methods — unchanged; tab strip order itself is NEVER reordered.

---

## UC-CP-006 Roast-purpose mismatch hint — zero-overlap only, educational (Friend)

**Goal:** a friend whose brewing gear matches NONE of a product's purpose gets one
educational line — never a block, never a false warning for a multi-method friend.

**Business rules:**

- Predicate (the ONLY trigger): `methods.length > 0 &&
  !purposesForMethods(methods).includes(product.purpose)`. Zero stored methods ⇒
  never a hint (unknown ≠ mismatch, UC-CP-002).
- **Surface (v1): the product detail modal only** (UC-CP-008) — a `.sub`-styled line
  under the attribute rows. Deliberately NOT on the product card: the card's markup
  and geometry are pinned by `order-product-card.spec.js` and a per-card warning at
  list scale is noise, not education. Extending to the card is a recorded possible
  follow-up, not v1.
- Proposed copy (vy-form, one line, purpose-parametrised):
  **"Táto káva je pražená na {purpose}. Podľa vášho profilu pripravujete kávu inak —
  chuť sa môže líšiť od očakávania."** `OPEN:` exact educational copy needs product
  sign-off (the PM may want per-purpose variants, e.g. explaining espresso roast in a
  french press).
- Never blocking: no effect on steppers, `canIncrement`, cart, submit — rendering a
  string is this UC's entire write surface.

**Acceptance criteria:** friend with `['capsules']` opening an Espresso product's
detail shows the hint; the same friend on a Kapsule product does not; a friend with
`['espresso','capsules']` sees it on neither; a friend with no methods sees it nowhere;
ordering the hinted product proceeds exactly as without the hint.

---

## UC-CP-007 Friend-facing catalog read — `/api/catalog/cycle/:cycleId` (Friend)

**Goal:** the display attributes for every linked snapshot in a cycle, fetched once per
order-page load — the ONLY catalog data friends ever receive.

**Route contract:**

- `GET /api/catalog/cycle/:cycleId` — requires a valid friend auth
  (`validateFriendAuth`; legacy shared-password acceptable — this is product data, not
  per-friend data, so no ownership target exists). 401 on no/invalid auth. **Never
  admin-guarded.** Resolved against module 12: its admin catalog routes live on
  `/api/coffee-products` (whole-mount `requireAdmin`, UC-PC-009), so `/api/catalog`
  carries ONLY this friend read — if anyone later adds admin routes here it becomes a
  MIXED router gated per route (the invitations/guest-orders precedent); never wrap
  the mount.
- 200 body: `{ products: { [products.id]: { coffee_product_id, country, region,
  altitude, farm, variety, processing } } }` — one entry per snapshot in
  the cycle **with a non-NULL `source_coffee_product_id`** (S12-link). Unlinked
  snapshots are simply absent (the frontend treats absence as "no details").
- ⚠ **The display set is a closed list.** No `SELECT *`: prices, `normalized_name`,
  `status`, `is_new`, `curator_pick_note`, timestamps stay unpublished (01-architecture:
  "catalog fields exposed to friends are the display set only"). Pinned by an
  exact-keys assertion in UC-CP-014.
- No image in this payload — the order page already has the snapshot's image; shipping
  the catalog copy would double the base64 weight (decision #6's reasoning).
- Empty values pass through as NULL; hiding empty rows is the frontend's job
  (UC-CP-008).

**`api.js`:** `getCatalogForCycle(cycleId)`.

**Acceptance criteria:** anonymous ⇒ 401; a friend token ⇒ 200 with only linked
snapshots keyed; response body raw-text contains no `price`, `normalized_name` or
`curator` substring; an unlinked snapshot's id is absent.

---

## UC-CP-008 Product detail modal — `ProductImageModal` extension (Friend)

**Goal:** tapping a product on the friend order page opens photo + attributes
(+ the UC-CP-006 hint) — one modal, guests untouched.

**Component (`ProductImageModal.vue` — extended, per resolved decision #1):**

- New optional props: `details` (array of `{ label, value }`, default `[]`) and
  `hint` (string, default `''`). `image` becomes optional (see no-photo rule below);
  **all props absent/empty ⇒ rendering byte-identical to today**, which is what keeps
  both guest call sites (`GuestProductGrid.vue` serving `/g/:token` AND the status/edit
  screen) untouched without an edit.
- Layout: the existing `<img>` block first (unchanged rules — `width:100%`,
  `height:auto`, deliberately no `max-height`; omitted entirely when `image` is empty),
  then the attribute rows, then the hint line, then the existing footer "Zavrieť".
  (No flavor-chips row — chips are deferred entirely, resolved decision #4.)
- **Attribute rows** — Goriffee vocabulary verbatim, fixed order, `.field-lbl`-style
  label + value; **a row with an empty/NULL value is NOT rendered** (brief Decision 9):
  1. **Krajina pôvodu** (`country`)
  2. **Región** (`region`)
  3. **Nadmorská výška** (`altitude`)
  4. **Farma** (`farm`)
  5. **Odroda kávy** (`variety`)
  6. **Spracovanie** (`processing`)
  Display-only: no filtering, no stats, no links. No friend "taste profile" surface
  exists anywhere in v1 — deliberately minimal.
- Stays on `NeoModal` (teleported out of `.app` — the `.app > *` rule makes a
  hand-rolled overlay structurally forbidden; the component's own comment block is the
  guard).

**Call-site rules (`FriendOrder.vue` — the only call site that changes):**

- The view fetches `getCatalogForCycle(cycleId)` once after products load (behind the
  session restore; failure degrades to photo-only modals — never blocks the product
  list) and maps snapshot id → `details`/`hint` at open time.
- **Trigger:** the existing photo tap opens the modal (same entry, richer content).
  When a product has NO photo but HAS details, the product name `<h3>` becomes the
  trigger, with the house zero-pixel ARIA layer (role/tabindex/Enter/Space — the
  keyboard-reachability rule from the lightbox itself). No photo AND no details ⇒ no
  trigger (today's behavior).
- **Accessible name of the trigger on the friend surface becomes
  `Zobraziť detail: <product>`** (it no longer only shows a photo). ⚠ Guest surfaces
  keep `Zobraziť fotku: <product>` — `product-photo-lightbox.spec.js` owns those
  locators; the friend-side rename is a case (a) spec edit citing this UC (UC-CP-014).
- Bakery products: no catalog, no details — photo-only lightbox as today.

**Acceptance criteria:** a friend product with country+region shows exactly those two
rows, empty attributes absent; a product with all six attributes empty opens
photo-only; `/g/:token` renders the photo-only modal with zero attribute rows even for
a linked product; keyboard: the no-photo trigger opens and closes the modal with
Enter/Escape.

---

## UC-CP-009 Review upsert — `/api/reviews` (Friend)

**Goal:** one endpoint writes a micro-review: verdict + optional brew method, one row
per (friend, catalog product), latest wins.

**Route contract (`backend/src/routes/reviews.js`, mounted BARE at `/api/reviews`,
friend-gated per route):**

- `PUT /friend/:friendId/product/:coffeeProductId` —
  `requireFriendOwner(req, req.params.friendId)`.
- Body: `{ verdict, brew_method? }`. `verdict` ∉ {`up`,`mid`,`down`} ⇒ 400
  `{ error: 'Neplatné hodnotenie', field: 'verdict' }`. `brew_method` present but ∉
  the five-method enum ⇒ 400 `field: 'brew_method'`; absent/null ⇒ stored NULL.
- **Purchase gate (resolved decision #3):** 400
  `{ error: 'Hodnotiť môžete len kávu, ktorú ste si objednali.' }` when the friend has
  no `order_items` row in a submitted order joined through S12-link to
  `:coffeeProductId`. Unknown catalog id falls under the same 400 (no existence oracle
  needed — the join simply finds nothing).
- **Upsert latest-wins:** `INSERT … ON CONFLICT(friend_id, coffee_product_id) DO UPDATE
  SET verdict = excluded.verdict, brew_method = excluded.brew_method,
  created_at = CURRENT_TIMESTAMP`. 200 `{ verdict, brew_method }`.
- **No `transactions` row, ever** (UC-CP-001 rule; zero-row asserted in UC-CP-014).
  No DELETE endpoint: changing a verdict is possible any time, removing one is not in
  v1 (recorded — the passport shows the latest verdict, and an "un-review" affordance
  has no UI home in the brief).
- Handlers are synchronous (better-sqlite3, no `await`) — the `instances: 1` atomicity
  posture holds; do not introduce an `await` between the purchase check and the upsert
  (the GA-T8 lesson).

**`api.js`:** `putReview(friendId, coffeeProductId, { verdict, brew_method })`.

**Acceptance criteria:** anonymous ⇒ 401; wrong friend ⇒ 403; unpurchased product ⇒
400; first PUT creates the row; second PUT with a different verdict leaves exactly ONE
row with the new verdict; `transactions` row count unchanged across all of it.

---

## UC-CP-010 Passport read — `GET /api/passport/friend/:friendId` (Friend)

**Goal:** one owner-guarded endpoint computes the whole passport payload — header
stats, history rows, reorder availability, the friend's methods and verdicts — so the
screen renders from a single fetch.

**Route contract (`backend/src/routes/passport.js`, mounted BARE at `/api/passport`):**

- `GET /friend/:friendId` — `requireFriendOwner`. All data below derives from the
  friend's OWN `order_items` in **submitted** orders (`orders.status = 'submitted'`),
  joined `order_items → orders → products → coffee_products` through S12-link, on
  coffee cycles only. ⚠ **Guest items NEVER count** — a host's passport is their own
  coffee, not their colleagues' (Decision-4 discipline: per-friend aggregates are
  friend-only; the sub-orders belong to guests, who have no passport).
- 200 body:

```
{
  stats: {
    products_tried,   // COUNT(DISTINCT coffee_product_id)
    countries,        // COUNT(DISTINCT coffee_products.country) over non-NULL countries
    total_kg,         // Σ variantToKg(variant, quantity) — the one weight authority
    streak            // computeStreak(orderedCoffeeCycleIds, allCoffeeCycleIds)
  },
  brew_methods: [...],          // the friend's junction rows (saves a second request)
  rows: [{
    coffee_product_id, name, country, purpose,
    times_ordered,              // DISTINCT cycles containing it (decision #10)
    last_ordered_at,            // MAX(orders.created_at) among qualifying orders
    verdict,                    // friend_reviews.verdict or null
    review_brew_method,         // friend_reviews.brew_method or null
    reorder: { cycle_id, product_id } | null
  }]                            // ordered last_ordered_at DESC
}
```

- **Weight authority is `variantToKg()`** (`helpers/analytics.js`) — imported, never
  re-inlined (`'unit'` and unknown variants score 0, exactly as everywhere else).
- **Streak** reuses `computeStreak` verbatim; both cycle-id arrays are coffee cycles
  ordered `created_at ASC, id ASC` (resolved decision #9).
- **`reorder`** is non-null when at least one cycle satisfies ALL of: `status = 'open'`,
  coffee type, contains a snapshot linked to the row's catalog product, and is visible
  to the friend under their subscriptions (no subscription rows ⇒ sees everything —
  the shipped rule). Several qualifying cycles ⇒ the newest (`created_at DESC, id DESC`
  — decision #9's tiebreak again); `product_id` is that cycle's snapshot id.
- **Unlinked history rows** (NULL `source_coffee_product_id` — pre-migration data or a
  snapshot the migration could not match) are silently excluded from rows AND stats.
  This is the honest reading of S12-link: the passport counts what the catalog can
  identify. Not an error state; the migration closing the gap is module 12's
  acceptance.
- No image field in rows (resolved decision #6). No flavor chips anywhere — deferred
  entirely (decision #4).
- Cancelled/draft orders never count (`status = 'submitted'` is the predicate — the
  same status-filter discipline every guest aggregate follows).

**`api.js`:** `getPassport(friendId)`.

**Acceptance criteria:** a friend with 2 linked coffees over 3 cycles (one twice) gets
`products_tried = 2`, correct `times_ordered` per row, kg equal to the variant math,
rows sorted newest-first; a friend with zero history gets `stats` of zeros and
`rows: []`; guest sub-orders under the friend's link move NO number in this payload;
anonymous ⇒ 401, wrong friend ⇒ 403.

---

## UC-CP-011 Passport screen — `/passport`, portal entry, header, list, empty state (Friend)

**Goal:** the "Moje kávy" screen: a new friend route on the Podpultovka skin.

**Routing + entry:**

- New route `/passport` → `PassportView.vue` (name proposed; `.app` scope, BrandChrome
  like every friend screen). Session handling copies `FriendOrder.vue`: restore from
  `localStorage.gorifi_friend_auth` in `onMounted`, redirect to `/` when
  unauthenticated. ⚠ e2e must enter via the portal card, not a bare `page.goto`
  (the `gotoFriendCard` race lesson).
- Portal entry: a card-row on `FriendPortalSession.vue` between the balance card and
  the cycle list — title **"Moje kávy"**, sub **"Vaša kávová história a hodnotenia"**,
  navigates to `/passport`. `OPEN:` placement + visual treatment need product/design
  sign-off (no prototype screen exists; compose from the shipped card grammar).
- Back chevron in the appbar returns to `/` (accessible name **"Späť"** — the
  substring-match lesson).

**Header stats (four `.mono`-figure tiles/rows, from `stats`):**

- **káv vyskúšaných** — `products_tried` with Slovak declension (1 káva vyskúšaná /
  2–4 kávy vyskúšané / 5+ káv vyskúšaných) — new `lib/plural.js` helper (the one home
  for declensions).
- **krajín** — `countries` (1 krajina / 2–4 krajiny / 5+ krajín).
- **kg spolu** — `total_kg` formatted by the house kg rule: up to 2 decimals, trailing
  zeros stripped, dot decimal (the RD-FO-2 `Math.round` rule — never `toFixed(2)`).
- **séria** — `streak` (1 cyklus po sebe / 2–4 cykly po sebe / 5+ cyklov po sebe);
  hidden when 0. This is a STAT, not a badge — the Verný-streak badge is module 14.
- `OPEN:` header labels + composition need product sign-off (proposed above).

**History list (one row per `rows[]` entry, newest first):**

- Line 1: product name (ellipsis-clipped by CSS, full string in `title` — the
  cart-line rule; never truncate in data) + country when present.
- Line 2 (`.sub`/`.mono` per the portal card grammar): **"objednané {N}× · naposledy
  {date}"** — date via the portal's existing date formatting convention.
- Verdict chips per UC-CP-012.
- **"Objednať znova"** button (`.btn`) only when `reorder` is non-null → UC-CP-013.

**First-ask + empty states (resolved decision #7):**

- `brew_methods.length === 0` ⇒ the question card renders at the TOP of the screen:
  the UC-CP-004 field group (same one-home labels/checkboxes) + a save button
  (**"Uložiť"**) calling `setBrewMethods`. Disappears once saved with ≥1 method. Not a
  modal, not dismissible-without-answering — it just sits there until answered, and the
  rest of the screen renders below it.
- `rows.length === 0` ⇒ neutral empty copy: **"Váš kávový pas je zatiaľ prázdny.
  Objednajte si kávu v otvorenom cykle a história sa začne písať tu."** — deliberately
  NO recommendation flow, NO button beyond a link back to the portal. This state is
  module 14's future entry point ("Pomôž mi vybrať" lands here); v1 renders neutral
  copy only. `OPEN:` copy sign-off.
- Both cards can render together (new friend: question + empty copy).

**NFRs:** zero horizontal overflow at 320 px (a new route joins
`mobile-no-h-overflow`'s obligation); at most one sticky bar (this screen needs none);
`.inp`-class rule does not apply (no text inputs), checkbox targets ≥24 px.

**Acceptance criteria:** portal card → `/passport` renders chrome + stats + rows for a
seeded friend; a methodless friend sees the question card, answers, card disappears and
the profile modal shows the same selection; a fresh friend sees both empty-state cards;
unauthenticated `goto /passport` bounces to `/`.

---

## UC-CP-012 Inline rating — verdict chips + brew chip default/override (Friend)

**Goal:** the passport IS the review surface: rate in place, no modals, no emails.

**Business rules:**

- Every history row renders the three verdict chips **👍 😐 👎** (fixed order),
  38 px min hit targets, with accessible names **"Chutila mi"** / **"Priemer"** /
  **"Nechutila mi"** (`OPEN:` sign-off). The stored verdict renders selected
  (`.sel`-style ink border + accent shadow per the vbox grammar); unrated rows show all
  three neutral.
- Tapping a chip PUTs immediately (`putReview`) with
  `brew_method = defaultMethodForPurpose(brew_methods, row.purpose)` (UC-CP-002 —
  single match or null; the brief's "defaults to whichever of the friend's methods
  matches the coffee's purpose"). Tapping the already-selected chip is a no-op (no
  un-review in v1 — UC-CP-009).
- After a verdict exists, a small brew chip renders beside the verdicts showing the
  stored method's label (or **"+ metóda"** when NULL). Tapping it expands the five
  method chips inline; picking one re-PUTs the same verdict with the new method — "one
  tap to override". Collapses on pick.
- Mutations are per-row pending-guarded (`rowSeq` map, the GSO-T5 rule — never one
  shared lock) and patched in place from the PUT response; a failed PUT reverts the
  chip and renders the error in a row-scoped line, vy-form.
- The verdict updates the row optimistically nowhere — selected state follows the
  response (a review is cheap; honesty beats latency here).

**Acceptance criteria:** tapping 👍 on an unrated row persists `up` + the defaulted
method (friend `['capsules']` × Kapsule coffee ⇒ `capsules`; friend
`['filter','frenchpress']` × Filter coffee ⇒ NULL — two matches, never guess);
tapping 👎 afterwards leaves one row with `down`; the override picker changes only
`brew_method`; reload shows the same state (server truth).

---

## UC-CP-013 "Objednať znova" — navigate + focus, never a cart write (Friend)

**Goal:** the retention loop: one tap from a passport row to the product's card in the
open cycle.

**Business rules:**

- The button navigates to `/cycle/{reorder.cycle_id}?product={reorder.product_id}`.
  **No cart mutation of any kind** (resolved decision #2).
- `FriendOrder.vue` handling of `?product=`: after products load, when the id matches a
  rendered product — set `activeTab` to that product's purpose (overriding UC-CP-005's
  default — explicit intent wins), scroll the product's card into view, then
  `router.replace` the query away (so reload/back does not re-scroll). Unknown/absent
  id ⇒ the param is ignored and replaced away; never an error.
- Scrolling the DOCUMENT to the card is correct here (`scrollIntoView` on the card) —
  the snapTab document-scroll hazard applies to the tab strip, not to a deliberate
  scroll-to-card; the strip itself must still be brought to the right tab via the same
  mechanism a tap uses.
- Staleness: `reorder` was computed at passport load; the cycle may have locked
  meanwhile. The order page's own shipped locked-state handling is the answer — the
  navigation is never gated client-side on freshness.
- The button label is **"Objednať znova"** verbatim (brief).

**Acceptance criteria:** tapping the button on a row whose product lives under the
Filter tab of the open cycle lands on the order page with Filter active and the card in
the viewport, cart empty; the URL carries no `product` param after settle; a stale link
to a since-locked cycle renders the shipped locked state.

---

## UC-CP-014 Verification — e2e obligations + touched locator owners (system)

**Goal:** how the implementing tasks prove the module; which locator-owning specs are
legitimately edited (e2e-immutability case (a) — each edit cites its mandating UC) and
which must pass unchanged.

**New spec files (fixtures per test, never a shared `beforeAll` — the GSO-T8 worker
lesson; friend routes ownership-tested per the house bar):**

1. `e2e/tests/brew-methods.spec.js` — UC-CP-003 API contract (401/403/filter/empty/
   idempotent), UC-CP-004 modal round-trip, UC-CP-005 tab-defaulting matrix (single
   method / union-of-one / multi-method unchanged / no methods unchanged).
2. `e2e/tests/coffee-reviews.spec.js` — UC-CP-009 (verdict/brew validation, purchase
   gate, upsert one-row, **zero `transactions` rows across every write** — the
   UC-CP-001 pin), UC-CP-012 chip flows incl. the brew-default matrix.
3. `e2e/tests/passport.spec.js` — UC-CP-010 payload math (stats, times_ordered,
   last-date ordering, kg vs variant math, **guest sub-order moves nothing** —
   Decision 4's pin), reorder eligibility (open/locked/subscription-hidden),
   UC-CP-011 screen states (question card, both empty cards, 320 px no-overflow),
   UC-CP-013 navigation + tab + scroll + query cleanup.
4. `e2e/tests/product-detail-modal.spec.js` — UC-CP-007 exact-keys + 401 + no-leak
   raw-text sweep (which also catches any stray `flavor_chips` in the payload),
   UC-CP-008 rows/empty-row-hiding, UC-CP-006 hint matrix,
   the guest counter-assertion (photo-only on `/g/:token`), keyboard reachability.

**Pre-existing locator-owning specs — legitimately edited (case (a), cite the UC):**

- `portal-profile-modal.spec.js` — owns the profile modal's rendered-copy sweep; gains
  the UC-CP-004 strings. Its FUP-T20 assertions must pass byte-unchanged.
- `product-photo-lightbox.spec.js` — friend-side trigger name becomes
  `Zobraziť detail: <product>` (UC-CP-008); guest-side assertions stay untouched.
- `mobile-no-h-overflow.spec.js` — gains `/passport` (or the passport spec carries its
  own 320 px assertion; either discharges the NFR — do not do both).

**Must pass UNCHANGED (they pin neighbouring behavior this module must not move):**
`order-shell.spec.js`, `order-product-card.spec.js` (card markup/geometry — UC-CP-006
deliberately avoided the card), `order-cartbar.spec.js`, `portal-cycles.spec.js`,
`portal-fidelity.spec.js`, `guest-order*.spec.js`, `guest-status*.spec.js`,
`api-security.spec.js` — **`ADMIN_ENDPOINTS` gains NOTHING from this module** (there
are no admin routes here; module 12's routes join it under its own spec).

**Procedure:** `node --check` on changed backend files (no unit runner — do not add
one); the CLAUDE.md local recipe (port-free check by owning PID, fresh `DB_PATH` +
seed, `CORS_ORIGIN` incl. the gate origin, ALL rate-limit buckets raised, output to a
file never `| tail`); targeted files first, then the full suite; manual staging
walkthrough: answer the question in the profile → order a coffee → migration-linked
history appears on `/passport` → rate it → Objednať znova lands on the card.

---

## Accepted risks / follow-ups (recorded, not silently implemented)

- **Legacy shared-password hole on the new friend routes** — inherited from the
  `subscriptions.js` posture deliberately (UC-CP-003); all data here is self-correcting
  preference/review data. Dies with the recorded "retire shared password" follow-up.
- **Reviews have no delete** (UC-CP-009) — change-only in v1; revisit if a friend asks.
- **Mismatch hint lives only in the detail modal** (UC-CP-006) — card placement is a
  possible follow-up, deliberately not v1.
- **`reorder` staleness between passport load and tap** — handled by the order page's
  shipped locked state, no freshness gate (UC-CP-013).
- **Orphaned junction/review rows after a hard friend delete** — invisible via joins;
  the in-transaction cleanup is the implementing task's tidy option (UC-CP-001).
- **Passport before migration** — truthfully empty until module 12's backfill runs
  (§Module-12 seams sequencing note).
- **Module 14 entry point** — the passport empty state is reserved for "Pomôž mi
  vybrať"; v1 renders neutral copy only (UC-CP-011).
- **Flavor chips deferred entirely (PM, 2026-08-22 — resolved decision #4).** Display
  AND storage/derivation return only with a future module; module 12 drops the column
  and the auto-tagger under the same decision. **Nothing in v1 may reference the
  column** — the UC-CP-007 raw-text sweep is the guard on the friend surface.

## OPEN items (for the product owner)

1. `OPEN:` **Copy sign-off** — brew-method option labels + help line (UC-CP-002/004),
   mismatch-hint line (UC-CP-006), passport header labels + declensions, portal entry
   card copy, empty-state copy (UC-CP-011), verdict-chip accessible names (UC-CP-012).
   All proposed verbatim above, vy-form, no gendered participles.
2. `OPEN:` **Passport entry card placement/visuals** — no prototype screen exists;
   proposed between balance card and cycle list (UC-CP-011).
3. `OPEN:` **A pushier first-ask surface** (one-time portal prompt) — dropped in v1 per
   resolved decision #7; product-level call if wanted.

~~Method→purpose mapping~~ — RESOLVED 2026-08-22: `moka → Espresso` and
`frenchpress → Filter` confirmed by the product owner (resolved decision #8).

Sources: `docs/requirements/2026-08-18-catalog-profiles-recommendations-brief.md` (v5,
§3 + §6 Decisions 7/8/9 + §7 data-model sketch); `docs/specification/00-overview.md`
(§Scope extension 2026-08-22, file index, glossary); `docs/specification/01-architecture.md`
(§Catalog & passport extensions, §Frontend structure, §i18n, §Testing & gate); repo code
(`backend/src/routes/subscriptions.js`, `backend/src/middleware/friend-auth.js`,
`backend/src/helpers/analytics.js`, `frontend/src/views/FriendPortalSession.vue`,
`frontend/src/views/FriendOrder.vue`, `frontend/src/components/ProductImageModal.vue`,
`frontend/src/lib/purposes.js`, `frontend/src/api.js`, `frontend/src/router.js`); repo
`CLAUDE.md` (friend-surface pins). The most recent decision wins on conflict.
