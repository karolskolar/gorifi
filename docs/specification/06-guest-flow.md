# 06 — Guest flow: g-order, g-confirm, g-status ×4, g-dead, checkout + Platba modals

> Scope: The redesign of the entire guest (colleague) surface: the public ordering page
> `/g/:token` (g-order) with its hero, product grid, cart footer and checkout modal; the
> post-submit confirmation (g-confirm); the personal status/edit page
> `/g/:token/o/:orderToken` (g-status, four states: editable / paid-frozen / read-only
> locked / cancelled, plus its edit mode); the dead-link screen (g-dead, three variants);
> the invite-CTA restyle; and the restyle of the shared **Platba** payment modal. This is
> a **re-skin plus the UX changes listed here** — no API, schema or business-logic change;
> every GSO invariant in repo `CLAUDE.md` (GSO-T3/T4/T6/T10) holds verbatim.
> Out of scope (handoffs): tokens, `friends-theme.css`, BrandChrome/NeoModal/NeoStepper/
> NeoCheckbox/NeoCopyRow/NeoIcon, the QR frame and money convention → `02-design-system.md`;
> the product-card / vbox / cat-tabs **anatomy** (defined once, consumed here) →
> `04-friend-order.md`; the host-side share dialog and colleagues panel →
> `05-colleagues-panel.md`; friend login/portal → `03-friend-login-portal.md`.
> The Platba modal is ALSO consumed by the friend order flow (module 04) — the
> shared-consumer contract is pinned in UC-GX-005.
> Actors: Guest (colleague) — unregistered, the URL token (pair) is their only credential;
> Friend (host) — appears only by name ("organizuje / odovzdá {host}"); Admin — appears
> only as the read-only `paid` flag and as payee.
> Sources: `docs/design/friends-portal-redesign/README.md` (§Screens items 7–10, §Shared
> modals — Platba, §Interactions, §Business rules), `docs/design/friends-portal-redesign/
> friends/guest.jsx` (reference implementation — copy transcribed verbatim), `friends/ui.jsx`
> (PaymentModal, RevolutBtn, CopyRow, QRBox), `friends/data.js` (payment reference shape),
> repo `frontend/src/views/GuestOrder.vue`, `views/GuestOrderStatus.vue`,
> `components/GuestProductGrid.vue`, `components/GuestInviteRequest.vue`,
> `components/PaymentModal.vue`, `lib/guest-cart.js`, `src/api.js` (`guestRequest`),
> `backend/src/routes/guest.js` (`statusPayload` — read-only reference), repo `CLAUDE.md`
> (GSO-T3/T4/T6/T10 invariants), `docs/superpowers/specs/2026-07-18-guest-shared-orders-design.md`
> (lifecycle), `e2e/tests/guest-order.spec.js`, `guest-status.spec.js`,
> `guest-lead-capture.spec.js`, `guest-admin-view.spec.js` (selector pins). The handoff
> bundle (2026-08) is canonical for visuals and copy; repo code is canonical for behavior.
> The most recent decision wins.
> **Design reference:** `screenshots/09-shot.png` (g-order), `10` (checkout), `11`
> (g-confirm), `12` (Platba modal), `14` (g-status paid), `15` (g-status cancelled),
> `16` (g-dead notfound); the live prototype (`Podpultovka Friends.html`, Kolega group)
> for the editable/locked status states and the dead-link variants. Note: the bundle's
> `13-shot.png` is a duplicate capture of the cancelled state (identical to 15) — the
> editable-state reference is the live prototype, not screenshot 13.

---

## Resolved conflicts (recency / canonicity)

1. **Locked-state banner copy.** README §Screens item 9 gives a long variant ("…Prípadnú
   zmenu skúste vyriešiť s organizátorom objednávky alebo objednávku môžete zrušiť.");
   `guest.jsx` (what the prototype actually renders) has the short
   "Objednávanie v tomto cykle je uzavreté, objednávku už nie je možné upraviť." —
   which is also the shipped copy. Resolution: **guest.jsx wins.** The README variant is
   additionally wrong on behavior: after the lock the server 409s a cancel (`PUT` on a
   non-open cycle, GSO-T4), so "objednávku môžete zrušiť" would promise an action the
   backend refuses.
2. **Invite-CTA fold line.** Shipped copy (GSO-T10) is "Chcete si nabudúce objednať
   sami?"; the prototype renders "Chcete si objednať sami?". The CLAUDE.md GSO-T10 pin is
   about the **register** (vy-form, no reader-gendered participle), which both satisfy;
   prototype copy is final (00-overview). Resolution: **prototype verbatim** —
   "Chcete si objednať sami?". Consequence: `guest-lead-capture.spec.js:470`
   (`toContainText(/nabudúce/i)`) must be updated (UC-GX-011).
3. **Invite CTA on a cancelled sub-order.** The prototype hides the CTA when cancelled
   (`!cancelled && <GuestInviteCta/>`); the shipped behavior and README §Business rules
   say the CTA renders whenever the server says `invite_request.available` (a cancelled
   guest is still a lead — GSO-T10 returns 201 there). Resolution: **server flag wins**
   (behavior is repo-canonical); the prototype's conditional is a demo simplification.
   Render the CTA in all four states when `available` and not editing.
4. **Payment-reference placement.** Shipped code shows a copyable reference row directly
   on the confirmation card and on the status card; README item 8 pins "Payment reference
   lives ONLY in the payment modal", and neither prototype screen renders it outside
   `PaymentModal`. Resolution: **modal-only** — the on-card reference rows are removed
   and the reference copy row moves into the restyled Platba modal (UC-GX-005).
   Consequence: `guest-order.spec.js:875` and `guest-status.spec.js:650` must open the
   modal first (UC-GX-011).
5. **Paid-frozen explanation banner.** Shipped status page shows an alert
   (`data-testid="paid-locked"`: "Platba je zaevidovaná, obsah objednávky už nie je možné
   zmeniť. Zmenu vyriešte so správcom…") plus "Platba je zaevidovaná. Ďakujeme."; README
   item 9 pins the paid state as "**pills only** + ghost Zrušiť objednávku" and the
   prototype renders exactly that. Resolution: **prototype wins** — both texts and the
   `paid-locked` element are dropped. Consequence: `guest-admin-view.spec.js:694–695`
   re-pins on the pills + ghost cancel instead (UC-GX-011).
6. **Copy-button flip label.** Shipped guest buttons flip to "Skopírované"; the design
   system (UC-DS-011, prototype `CopyRow`) pins "Skopírované!". Resolution:
   **"Skopírované!"** everywhere on guest surfaces. Consequence: the `toHaveText`
   assertions in `guest-order.spec.js:888–893` update (UC-GX-011).

---

## UC-GX-001 g-order — page scaffold, brand header, hero card (Guest)

**Goal:** `/g/:token` (`frontend/src/views/GuestOrder.vue`) renders in the Neobrutal
language: `.app` root, guest brand chrome, and the `.card.hl` cycle hero.

**Preconditions:** module 02 landed (stylesheet, fonts, primitives). Load behavior is
unchanged: `api.getGuestOrderPage(token)` → `{ cycle, host, products, availability }`;
404/410 falls through to UC-GX-010.

**Main flow / structure:**

1. View root becomes `<div class="app">` (single-theme; the per-tab background tinting
   — `bg-sky-100`/`bg-stone-200`/… `backgroundClass` — is **removed**: the prototype
   background is uniform `--bg` everywhere).
2. **Guest brand header** — new shared component
   `frontend/src/components/GuestBrandHeader.vue` (one home for all guest screens),
   prop `subtitle` (String, default `"Spoločná objednávka"`). It composes `BrandChrome`
   (UC-DS-006): `#titles` slot = wordmark
   `<span class="t">Pod<span style="color:var(--accent)">pult</span>ovka</span>` +
   `<span class="s">{{ subtitle }}</span>`; `#trailing` = `<span class="chip acc">Bez
   účtu</span>`; ticker prop (all guest screens, coffee and bakery alike):
   `"+++ KÁVA POD PULTOM +++ BEZ ÚČTU · BEZ REČÍ +++ POŠLI ODKAZ ĎALEJ +++"`.
   This screen's subtitle: **"Objednávka cez odkaz"**.
3. Page column: `max-width:760px`, centered, padding 16 px phone / 28 px desktop,
   `padding-bottom:8px`, vertical gap 14 px; root is a flex column `min-height:100vh`
   with the column `flex:1` so the cartbar (UC-GX-003) sits at the viewport bottom on
   short pages (prototype `GOrder` layout; the current `<div class="h-32">` spacer +
   `fixed` footer pattern is replaced by the sticky `.cartbar` — see UC-GX-003).
4. **Hero** `.card.hl` (white, 3px ink border, `6px 6px 0 var(--accent)` shadow),
   padding 16 phone / 20 desktop, in source order:
   - `h1.h-screen`, font-size 30 phone / 38 desktop: `{{ cycle.name }}`.
   - `.sub` (margin-top 8, 14px): `Spoločná objednávka · organizuje
     <b style="color:var(--ink)">{host.first_name}</b>`.
   - `.mono` deadline line (12.5px, margin-top 6, flex + gap 6, color `--ink-dim`),
     only when `cycle.expected_date`: `NeoIcon name="cal"` + text
     `Objednávka do: {cycle.expected_date}`.
   - Badge row (flex, gap 6, wrap, margin-top 12): `span.badge.acc` **Login netreba** ·
     `span.badge` **Platba prevodom** · `span.badge.acc-o` **Tovar odovzdá
     {host.first_name}**.
   - `.sub` (margin-top 10, 13px): **"Vyberte si tovar, na konci zadáte len meno a
     telefón."** (prototype copy — replaces the shipped "Účet netreba. Vyberte si
     tovar, na konci zadajte meno a telefón."; "Účet netreba" now lives in the chip).
   - `cycle.plan_note`, when present, stays as one more `.sub` line (13px) after the
     helper sentence — the prototype is silent on it, but dropping admin-entered copy
     would be a behavior regression, so it is retained.

**Business rules:**

- Loading state stays ("Načítavam…", `.sub`, centered) — rendered inside `.app` under
  the brand header so the chrome never flashes in and out.
- `document.title` watchEffect unchanged (`"{cycle.name} - Objednávka"`).
- `api.js guestRequest` is untouched: **no auth headers on any guest call** (GSO-T3 —
  the URL token IS the credential). This module adds no API calls and changes none.
- Host is always referred to by `host.first_name` exactly as today.

**Acceptance criteria:**

- Side-by-side with `screenshots/09-shot.png` at 378 px: black appbar with wordmark +
  rotated "BEZ ÚČTU" chip, hazard tape, magenta ticker, hero card with magenta offset
  shadow, three badges (first magenta rotated, third pink `--hi`).
- `e2e` pins survive: cycle name, host name and marked-up price visible on the page
  (`guest-order.spec.js:829–832`).
- No horizontal overflow at 320 px.

---

## UC-GX-002 Guest product grid restyle — `GuestProductGrid.vue` (Guest)

**Goal:** the shared grid (**one home, two screens** — g-order and g-status edit mode;
GSO-T4: extend, never fork) renders the prototype's cat-tabs and product cards.

**Main flow:**

1. Replace the radix `Tabs/TabsList/TabsTrigger/TabsContent` scaffolding with the theme
   structure: `div.cat-tabs` of `span.tab` (+` on` when active), tap = `snapTab(e)`
   (UC-DS-012 — center in strip, never `scrollIntoView`) then set `activeTab`; below it
   one card list (flex column, gap 16) for the active purpose. The tab strip renders
   only when `availablePurposes.length > 1` (unchanged rule). The per-tab
   `getTabTriggerClass` tint map is **deleted** (conflict-free: the neo tabs have one
   selected style).
2. **Card anatomy is module 04's** (f-order product cards / f-bakery cards): image in
   the 2px-ink `.pimg` frame, name + roast/roaster badges, spec line, mono tasting
   notes, `.vbox` variant boxes (selected = `.sel`: 3px ink border, `3px 3px 0` magenta
   shadow, magenta `.vprice`), stock-limit bar, bakery card with per-variant rows.
   This module does not respecify it — the guest card must be **pixel-identical to
   04's card** (see `04-friend-order.md`, product-card and bakery-card UCs). What IS
   this module's contract is everything below.
3. Steppers become `NeoStepper` (UC-DS-008) inside each `.vbox` / bakery variant row.
   **Seam back to 02 (visual no-op extension, same precedent as the ARIA layer):**
   `NeoStepper` gains optional props `decTestid` / `valTestid` / `incTestid`
   (rendered as `data-testid` on the −, value and + elements) and `incDisabled`
   (Boolean — `disabled` attr + `.35` opacity on the + button only). Without these the
   pinned selectors below are unreachable.

**Business rules (behavior — unchanged, restated as the do-not-regress contract):**

- Cart model stays the flat `{ "productId-variant": qty }` two-way `defineModel`;
  `lib/guest-cart.js` is **not modified** (pure functions, no styling in it).
- Stock gate: `canIncrement`/`getRemainingGrams`/`cartGramsForProduct` logic verbatim;
  the + button gets `incDisabled` when `!canIncrement(...)` (coffee) and the handler
  still early-returns — the server remains the authority (GSO-T3 `helpers/stock.js`).
- Stock bar semantics: fill % and the "Vypredané" / `Zostáva: {n}g z {limit}g` labels
  keep their exact computation; colors move to theme tokens per 04's stock-bar spec
  (danger when 0, warn under 25 %, accent otherwise).
- Bakery grouping by `source_bakery_product_id`, `variant_label` rows, composition
  behind `<details>` ("Zloženie") — all unchanged.
- Empty state: `banner slim` with the existing text
  "V tomto cykle zatiaľ nie sú žiadne produkty." (`emptyMessage` prop kept).
- **Pinned test hooks preserved verbatim:** `product-{id}` on each card;
  `inc-{variant}` / `dec-{variant}` / `qty-{variant}` on coffee steppers;
  `inc-unit-{id}` / `dec-unit-{id}` / `qty-unit-{id}` on bakery rows
  (`guest-order.spec.js`, `guest-status.spec.js` edit flows).
- Availability prop contract unchanged (status screen passes the
  `excludeGuestOrderId`-adjusted map; the grid must not care which screen feeds it).

**Acceptance criteria:**

- Editable-state prototype comparison at 378 px: sticky `.cat-tabs` (top edge, z 40,
  right-edge fade, hidden scrollbar) with tap-to-center; selected `.vbox` shows ink
  border + magenta shadow + magenta price.
- e2e grid interactions stay green without selector edits: `inc-250g` ×2 →
  `cart-total` 25.00 (`guest-order.spec.js:833–838`); bakery `qty-unit-*` seeding
  (`guest-status.spec.js:729–750`).

---

## UC-GX-003 g-order — sticky cartbar + checkout modal (Guest)

**Goal:** the cart footer and the "Dokončiť objednávku" checkout, per prototype
`GOrder` and `screenshots/10-shot.png`.

**Cartbar structure (`.cartbar`, sticky bottom, z 50, `0 -6px 0` accent shadow):**

```html
<div class="cartbar">
  <div class="meta">
    <span class="deadline">Objednávka do: {{ cycle.expected_date }}</span>
    <span class="sub" style="font-size:13px">Položiek: {{ cartItems.length }}</span>
  </div>
  <div class="meta" style="margin-top:2px;align-items:center">
    <span class="sum" data-testid="cart-total">Celkom: {{ formatPrice(cartTotal) }}</span>
    <button class="btn accent sm" data-testid="open-checkout"
            :disabled="cartItems.length === 0" @click="openCheckout">Objednať</button>
  </div>
  <details> <summary>Zobraziť položky v košíku</summary>
    <div class="lines">
      <div class="ln" v-for="…"><span>{name} ({variantText}) ×{qty}</span>
        <span class="mono">{{ formatPrice(line.total) }}</span></div>
    </div>
  </details>
</div>
```

- The deadline line renders only when `cycle.expected_date` exists. Line labels use
  `×` (multiplication sign, prototype) not `x`. `<details>` renders only when the cart
  has lines (shipped rule).
- One accent action only — **Objednať** (`btn accent sm`), disabled on an empty cart.
- `.cartbar` is `position:sticky` (theme.css) as the last child of the flex column —
  the `fixed` footer + `h-32` spacer pattern is removed. At most one sticky bar per
  edge (UC-DS-005): `.cat-tabs` top, `.cartbar` bottom.

**Checkout modal** — `NeoModal` (UC-DS-010; replaces the radix Dialog; `role="dialog"`
is preserved by the primitive, which the e2e `getByRole('dialog')` lookups need):

| Field | Element / constraints |
|---|---|
| Meno * | `input.inp`, `id="guest-name"`, `data-testid="guest-name"`, placeholder `Meno a priezvisko`, `maxlength="120"` (GSO-T3 mirror) |
| Mobil * | `input.inp`, `id="guest-phone"`, `data-testid="guest-phone"`, placeholder `0901 234 567`, `inputmode="tel"`, `maxlength="32"` |
| E-mail (nepovinné) | `input.inp`, `id="guest-email"`, `data-testid="guest-email"`, placeholder `meno@example.com`, `inputmode="email"`, `maxlength="160"` |

- Title **"Dokončiť objednávku"**; rich `#subtitle`: `Suma na úhradu:
  <b class="mono" style="color:var(--ink)">{formatPrice(cartTotal)}</b>. Platba
  prevodom, tovar vám odovzdá {host.first_name}.`
- Labels via `label.field-lbl` (native, no `ui/label`).
- Inline error: `div.banner.danger.slim` with `.dot`, `data-testid="checkout-error"`,
  below the fields. Client-side messages verbatim (server re-validates — Decision 7):
  `"Zadajte svoje meno."` · `"Zadajte telefónne číslo (aspoň 9 číslic)."` (≥9 digits
  after stripping non-digits) · `"Košík je prázdny."` (shipped extra guard, kept).
  Server errors keep the shipped join: `[e.message, ...(e.details || [])].join(' ')`.
- Footer: `btn` **Späť** (closes) · `btn accent` **Odoslať objednávku**
  (`data-testid="guest-submit"`, disabled while submitting, label flips to
  "Odosielam…").

**Business rules:**

- Submit behavior byte-identical to shipped `submitOrder()`: payload trims name/phone,
  email only when non-empty, `itemsPayload(cartItems)`; on success store the status URL
  in `localStorage.gorifi_guest_orders` keyed by link token (schema and try/catch
  swallow unchanged), close checkout, show g-confirm, and **auto-open the Platba modal
  when `payment.iban || payment.revolut_username`** (README: "in production auto-open
  on submit" — reconciled: current behavior already does this; keep it, and the green
  Zaplatiť button re-opens it, UC-GX-004).
- 409 (locked mid-shop) / 400 (bounds, stock) render in the checkout error banner —
  no redirect (shipped behavior).

**Acceptance criteria:** checkout at 378 px matches `10-shot.png` (display-font modal
title, 3px-ink inputs, mono sum in the subtitle); the e2e submit flow
(`guest-order.spec.js:833–864`) passes with the payment dialog auto-opening.

---

## UC-GX-004 g-confirm — confirmation screen (Guest)

**Goal:** the post-submit confirmation per prototype `GConfirm` and
`screenshots/11-shot.png`. Same route (in-page state on `GuestOrder.vue`), brand-header
subtitle **"Objednávka odoslaná"**.

**Structure (column max-width **520 px**, centered, padding 16/28, gap 16):**

1. Centered header block: `span.badge.ok-solid` rotated −2°, font-size 13, padding
   `6px 14px`: **"✔ Odoslané"** · `h1.h-screen` 34 phone / 40 desktop:
   `Objednávka je <span class="hl">odoslaná</span>` (the `.hl` magenta highlight with
   the 4px ink underline shadow) · `.sub` (margin-top 10):
   `{cycle.name} · organizuje {host.first_name}`.
2. **Sum card** (`.card`, padding 16): row `span.field-lbl` (margin 0) **"Suma na
   úhradu"** ↔ `span.display` 24px `{formatPrice(confirmation.payment.amount)}`;
   `hr.divider` (12px vertical margins); item lines (13.5px, `--ink-dim`, gap 5):
   `{product_name} ({variantText}) ×{qty}` ↔ `span.mono` bare `toFixed(2)` (no "EUR"
   on lines — prototype).
3. `button.btn.ok.block` **Zaplatiť** — opens the Platba modal (UC-GX-005). Rendered
   only when `payment.iban || payment.revolut_username` (shipped gate kept — without a
   payment destination there is nothing to open; the reference alone is a transfer
   note with nowhere to send it).
4. Status-URL field: `label.field-lbl` **"Odkaz na vašu objednávku — uložte si ho"** +
   `NeoCopyRow :value="confirmation.status_url"` with `data-testid="guest-status-url"`
   on the row (fallthrough to the `.copyrow` root; the copy button is addressed as
   `getByTestId('guest-status-url').getByRole('button')` — UC-GX-011). The shipped
   helper line "Na tomto odkaze uvidíte stav objednávky. Odkaz je uložený aj v tomto
   prehliadači." stays as `.field-help` under the row (prototype-silent; retained —
   it explains the localStorage behavior).
5. Invite CTA (UC-GX-009).
6. `button.btn.ghost.sm` (self-centered) **"Zobraziť stav objednávky"** +
   `NeoIcon name="chev"` — **new UX affordance from the prototype**: navigates to
   `result.status_path` (router push to `/g/:token/o/:orderToken`). Pure navigation,
   no API call.

**Removed from the shipped screen (conflict #4 + prototype):** the on-card payment
reference block ("Poznámka k platbe…" + copy button) — the reference now lives only in
the Platba modal; the "✅" emoji header; the "Tovar vám odovzdá {host}." footer line
(the checkout subtitle already said it).

**Business rules:**

- `data-testid="guest-confirmation"` stays on the screen container.
- The Platba modal auto-opens on arrival (UC-GX-003); closing it leaves this screen
  with the green Zaplatiť to re-open.
- `rememberStatusUrl` (localStorage `gorifi_guest_orders`, keyed per link token,
  newest-wins, failure-swallowing) is behavior — untouched.
- Payment data comes ONLY from the submit response (GSO-T3: never from the public
  listing) — this module must not add any payment fetch.

**Acceptance criteria:** 378 px side-by-side with `11-shot.png` (rotated green badge,
highlighted "ODOSLANÁ", sum card typography); copy-row flip per UC-DS-011
("Skopírované!", 2 s, green).

---

## UC-GX-005 Platba modal restyle — `PaymentModal.vue` (Guest, Friend)

**Goal:** the shared payment modal in the neo shell, per prototype `PaymentModal` /
`RevolutBtn` (ui.jsx) and `screenshots/12-shot.png`.

**Shared-consumer contract (pinned):** `PaymentModal.vue` is consumed by
`GuestOrder.vue`, `GuestOrderStatus.vue` AND `FriendOrder.vue` (module 04). Its props
API is **frozen**: `open` (Boolean), `amount` (Number), `reference` (String), `iban`
(String), `revolutUsername` (String); emits `close`. No admin view consumes it (repo
grep 2026-08-07). Because `NeoModal` teleports to `<body>` and tokens ride on
`.modal-layer` (UC-DS-010), the restyled modal renders correctly from any friend or
guest screen regardless of the caller's own migration state — module 04 inherits this
restyle without changes on its side.

**Structure:** `NeoModal` (replaces radix Dialog; `role="dialog"` preserved), title
**"Platba"**, rich subtitle `Suma na úhradu: <b class="mono">{formatPrice(amount)}</b>`
(keep the shipped `'-'` guard for a falsy amount), footer `btn` **"Zavrieť"**. Body
(gap per `.m-body`):

1. **Revolut button** — only when `revolutUsername`: an `<a>` styled `btn block` with
   inline `background:#0075EB; color:#fff` (border stays ink — prototype
   `borderColor:#0a0a0a`), the Revolut glyph SVG from ui.jsx `RevolutBtn`, label
   **"Zaplatiť cez Revolut"**, `href="https://revolut.me/{revolutUsername}"`,
   `target="_blank" rel="noopener noreferrer"` (shipped link behavior kept — the
   prototype button is inert demo).
2. **Pay by Square** — only when `iban`: centered block; `.sub` (margin-bottom 10)
   **"Pay by Square (QR kód pre bankovú appku)"**; the **real** generated QR `<img>`
   inside `<div class="qr">` styled `display:block;width:100%;height:100%` (UC-DS-012
   — the `.qr .grid` pseudo-QR is prototype-only, never rendered); `.sub.mono`
   (margin-top 10, 12px) **"IBAN: {iban}"**. The `bysquare` + `qrcode` generation code,
   the watch trigger, and the loading/error strings ("Generujem QR kod...",
   "Nepodarilo sa vygenerovat QR kod.") are behavior — byte-identical.
3. **Reference row (NEW — this is where the reference now lives, conflict #4):** only
   when `reference` is set: `label.field-lbl` **"Poznámka k platbe (uveďte ju pri
   platbe)"** + `NeoCopyRow :value="reference" small` carrying
   `data-testid="payment-reference"` (fallthrough to the `.copyrow` root). The
   reference format is server-owned (`guestPaymentReference()` — `G{id} / {meno} /
   {cyklus}`, e.g. `G8 / Karol Skolar / Goriffee August 2026`); the frontend never
   composes it.

**Business rules:**

- Section order fixed: Revolut → QR/IBAN → reference (prototype).
- When neither `iban` nor `revolutUsername` is configured, callers already hide the
  Zaplatiť trigger (shipped gates kept) — the modal never opens payment-empty.
- FriendOrder passes `reference` today exactly as the guest screens do; the new
  reference row appears for friends too — that is the prototype's intent (README
  §Shared modals lists Platba once, with the reference row, for both).

**Acceptance criteria:** 378 px side-by-side with `12-shot.png` (blue Revolut bar with
ink border, QR in the 190×190 ink frame, mono IBAN); a scanned QR resolves to the same
Pay-by-Square payload as before the restyle; `guest-status.spec.js:653–665` (open →
"Platba" + amount → Zavrieť → dialog count 0) passes.

---

## UC-GX-006 g-status — read view, four states (Guest)

**Goal:** `/g/:token/o/:orderToken` (`GuestOrderStatus.vue`) per prototype `GStatus`,
`screenshots/14-shot.png` (paid) and `15-shot.png` (cancelled). Brand-header subtitle
**"Vaša objednávka"**. Column max-width **520 px**, padding 16/28, gap 14.

**State derivation (behavior — unchanged, server-driven; the page can never offer an
action the backend would refuse):** `editable` and `items_editable` from
`statusPayload` (GSO-T6: `items_editable = editable && !paid`); `isCancelled` =
`order.status === 'cancelled'`; `isPaid` / `isDelivered` read-only (single owners:
admin / host). The `items_editable === undefined` fallback for older payloads stays.

**Structure (source order):**

1. Header block: `h1.h-screen` 30/36 `{cycle.name}`; `.sub` (margin-top 8)
   **"Vaša objednávka · organizuje a odovzdá {host.first_name}"** (prototype adds
   "a odovzdá" to the shipped line); guest name bold (`font-weight:700`, margin-top 4).
   Container keeps `data-testid="guest-status"`.
2. **Cancelled** replaces the pills with `div.banner.danger` (+`.dot`),
   `data-testid="status-cancelled"`: `Táto objednávka bola <b>zrušená</b>. Ak si
   chcete objednať znova, požiadajte kolegu o odkaz na spoločnú objednávku.`
   Otherwise the **status pills** row (flex, gap 8, wrap):
   - `span.statuspill` `.ok` **Zaplatené** / `.warn` **Nezaplatené** — each with
     `span.sq`; `data-testid="status-paid"`.
   - `span.statuspill` `.ok` **Odovzdané** / `.off` **Zatiaľ neodovzdané** —
     `data-testid="status-delivered"`. (The prototype hardcodes the `.off` variant;
     the delivered=true rendering is `.ok`, per the theme's green=done grammar,
     UC-DS-013.)
3. **Items card** (`.card`, padding 16): when cancelled, `div.field-lbl` **"Zrušené
   položky"** first, and the lines get `text-decoration:line-through` with no divider
   and no total (e2e pins: `status-total` count 0, "Zrušené položky" visible). Lines
   (13.5px, `--ink-dim`, gap 6, `data-testid="status-item"` each):
   `{product_name} ({variantText}) ×{qty}` ↔ `span.mono` bare `toFixed(2)`. When not
   cancelled: `hr.divider`, then `span.field-lbl` **"Celkom"** ↔ `span.display` 22px
   `{formatPrice(order.total)}` with `data-testid="status-total"`. The shipped
   zero-item fallback line ("Žiadne položky · {total}", `status-total`) stays.
4. **Actions by state** (all behavior gates shipped, restyled):
   - *editable* (`items_editable`): one row (flex, gap 8) — `btn` flex 1 **Upraviť**
     (`data-testid="start-edit"`) · `btn ok` flex 1.6 **Zaplatiť**
     (`data-testid="open-payment"`, only when `!isPaid && hasPaymentDetails` — always
     true here since paid ⇒ not items-editable).
   - *paid-frozen* (`editable && isPaid`): pills already say Zaplatené; below the card
     only `btn ghost sm` in `--danger` **Zrušiť objednávku**
     (`data-testid="cancel-order"`, disabled while saving, label "Ruším…" during) →
     UC-GX-008. No banner, no thank-you line (conflict #5). Direct cancel — no edit
     mode needed (GSO-T6).
   - *read-only / locked* (`!editable && !isCancelled`): `btn ok block` **Zaplatiť**
     when `!isPaid && hasPaymentDetails`; then `div.banner.warn.slim` (+`.dot`),
     `data-testid="status-readonly"`, wording by the shipped `readOnlyReason`
     computed: cycle not open → **"Objednávanie v tomto cykle je uzavreté, objednávku
     už nie je možné upraviť."** (= prototype, conflict #1); link/host dead →
     **"Odkaz na túto spoločnú objednávku už nie je aktívny, objednávku už nie je
     možné upraviť."** (shipped copy kept — the prototype has no dead-link-while-
     holding-a-status-URL variant, and the read-side resolver is deliberately
     404-only, GSO-T4: the order stays visible).
   - *cancelled*: nothing besides the banner, the struck items and (per conflict #3)
     the invite CTA. Terminal — no edit, no pay, no cancel (`start-edit` /
     `open-payment` count 0, e2e-pinned).
5. Error surface for a cancel attempted outside edit mode: `banner danger slim`,
   `data-testid="status-error"` (shipped rule: only rendered when not editing).
6. Invite CTA (UC-GX-009): rendered when `invite_request.available && !editing`, in
   **all four states** (conflict #3).

**Removed from the shipped read view (conflict #4/#5):** the on-card
"Poznámka k platbe…" reference row (now only inside Platba — reachable via Zaplatiť
whenever unpaid and payment details exist); the `paid-locked` alert; the
"Platba je zaevidovaná. Ďakujeme." line; the "Tovar vám odovzdá {host}." line (the
header now says "organizuje a odovzdá").

**Business rules:**

- The `loadSeq` guard on every async request and the `[token, orderToken]` watch
  reload are load-bearing (GSO-T2 lesson) — must survive the restyle verbatim.
- `refreshStoredEntry` localStorage sync unchanged (only-our-entry rule included).
- Background is uniform `--bg` in every state (the `bg-muted` cancelled tint goes;
  the danger banner carries the state).
- `document.title` watchEffect unchanged.

**Acceptance criteria:** paid state matches `14-shot.png` (green Zaplatené pill with
square, stone Zatiaľ neodovzdané, items card, ghost red cancel below); cancelled
matches `15-shot.png` (danger banner, struck lines under "ZRUŠENÉ POLOŽKY", no total);
editable/locked states match the live prototype; `guest-status.spec.js:636–689` passes
with the UC-GX-011 updates only.

---

## UC-GX-007 g-status — edit mode (Guest)

**Goal:** the in-place edit flow per prototype `GStatus` editing branch. Brand-header
subtitle switches to **"Úprava objednávky"**; column widens to the grid layout
(max-width 760, padding 16/28, gap 14, flex column with the cartbar at the bottom —
same scaffold as UC-GX-001).

**Structure:**

1. Intro banner `div.banner.slim` (+`.dot`): `Upravujete objednávku pre
   <b>{order.guest_name}</b>. Zmeny sa prejavia po uložení.` (new prototype copy).
2. Edit error above the grid: `banner danger slim`, `data-testid="edit-error"`.
3. `GuestProductGrid` (UC-GX-002) seeded via `cartFromOrderItems(items)` — unchanged.
4. `.cartbar`: `.meta` row `span.sum` (`data-testid="edit-total"`)
   `Celkom: {formatPrice(cartTotal)}` ↔ `.sub` 13px `Položiek: {n}`; `.actions` row —
   `btn sm` **Späť** (`data-testid="abort-edit"`, disabled while saving) · `btn accent
   sm` **Uložiť zmeny** (`data-testid="save-edit"`, disabled while saving, label
   "Ukladám…"); below the actions `btn ghost sm` styled `color:var(--danger);
   margin-top:4px` **Zrušiť objednávku** (`data-testid="cancel-order"`).

**Business rules (behavior — unchanged):**

- Entering edit resets the error and rebuilds the cart from the persisted items;
  leaving via Späť discards silently (shipped).
- **Emptying the cart funnels into the cancel confirm** (UC-GX-008): `saveEdit()` with
  zero lines opens the confirm instead of saving — because the server treats a literal
  `items: []` as the irreversible cancel and *only* that (GSO-T4: destructive action
  requires explicit intent).
- `submitEdit` semantics verbatim: PUT with `{ items }`; success applies the returned
  payload (no follow-up GET) and leaves edit mode; 409/410 exits edit mode and
  reloads so the page re-explains itself (read-only notice or terminal cancelled);
  400 stays in edit with the joined message; the un-guarded `saving` reset in
  `finally` stays (single-flight by disabled buttons).
- Identity is frozen — edit mode is **items-only**, no name/phone/email fields
  anywhere in it (GSO-T4).
- Invite CTA hidden while editing (shipped rule).

**Acceptance criteria:** live-prototype comparison (Upraviteľná → Upraviť); e2e edit
flows (`guest-status.spec.js:672–699` coffee, `729–750` bakery) pass without selector
edits.

---

## UC-GX-008 Cancel confirmation modal (Guest)

**Goal:** the shared "Zrušiť objednávku?" confirm, per prototype `GCancelModal` —
reached from edit mode, from the paid-frozen direct cancel, and from the empty-cart
funnel.

**Structure:** `NeoModal`, title **"Zrušiť objednávku?"**, subtitle **"Objednávka sa
zruší a už ju nebude možné obnoviť. Ak si budete chcieť objednať znova, požiadajte
kolegu o odkaz."**; body: `div.banner.danger.slim` (+`.dot`) **"Toto sa nedá vrátiť
späť."** (new prototype element); footer: `btn` **Ponechať**
(`data-testid="keep-order"`) · `btn danger` **Zrušiť objednávku**
(`data-testid="confirm-cancel-order"`, disabled while saving, label "Ruším…").

**Business rules:** confirm calls `submitEdit([])` — the only payload the server
accepts as a cancel; cancelled is terminal (no revive path; the e2e pins `start-edit`
and `open-payment` disappear afterwards). Keep = close, nothing sent.

**Acceptance criteria:** cancel flow e2e (`guest-status.spec.js:761–782`) green;
modal visuals per NeoModal (4px border, 8px shadow).

---

## UC-GX-009 Invite CTA restyle — `GuestInviteRequest.vue` (Guest)

**Goal:** the lead-capture CTA per prototype `GuestInviteCta` — one component, both
guest screens (extend, never fork). All behavior (endpoint, prefill, 409 handling)
is GSO-T10's and unchanged.

**States & structure (root keeps `data-testid="invite-cta"`):**

1. **Folded** (default): `.card` with inline `padding:10px 12px; background:var(--hi)`;
   row (flex, gap 10, center): icon box `span` 36×36, 3px ink border, radius 9, white,
   `2px 2px 0` ink shadow, rotate −3°, containing `NeoIcon name="invite"`; `.display`
   headline (flex 1, 17px, line-height .95) **"Chcete si objednať sami?"** (conflict
   #2); `btn sm` (min-height 34, `padding:6px 10px`, 12.5px)
   **"Požiadať o účet"** (`data-testid="invite-cta-open"`).
2. **Unfolded** (same card, column, gap 12, padding 4): `.display` 21px **"Žiadosť o
   vlastný účet"**; `.sub` 13px **"Správca vás pridá medzi priateľov a nabudúce si
   objednáte priamo."** (prototype verbatim — drops the shipped ", bez kolegu");
   fields — same table as UC-GX-003 but ids/testids `invite-name` / `invite-phone` /
   `invite-email`, labels **Meno \*** / **Mobil \*** / **E-mail (nepovinné)**, email
   placeholder `meno@example.com`, maxlengths 120/32/160, prefilled **at open time**
   from the sub-order props (shipped rule — props arrive async on the status page);
   error `banner danger slim` `data-testid="invite-error"`; button row (flex, gap 8):
   `btn sm` flex 1 **Späť** · `btn sm dark` flex 1 **Odoslať žiadosť**
   (`data-testid="invite-submit"`, disabled while submitting, "Odosielam…").
3. **Done** (this-session 201): `div.banner.ok.slim` (+`.dot`),
   `data-testid="invite-done"`: `<b>Žiadosť o účet je odoslaná.</b> Správca sa vám
   ozve.`
4. **Already requested** (server `invite_request.requested`, or learned from a 409 —
   README: 409 → "žiadosť už evidujeme"): `div.banner.slim` (neutral accent-soft;
   prototype has no such state — styling decision recorded here),
   `data-testid="invite-requested"`: **"Žiadosť o účet už evidujeme. Správca sa vám
   ozve."** (shipped copy kept).

**Business rules (unchanged, restated):** POST
`/guest/:token/orders/:orderToken/invite-request`, no auth headers; client validation
"Zadajte meno." / "Zadajte telefónne číslo (aspoň 9 číslic)."; 409 → the requested
state, never a retry invitation; rendering condition is the server's `available` flag
(confirmation screen: always offered — the endpoint it just used proves the link is
alive; status screen: `invite_request.available && !editing`, all four states,
conflict #3). Vy-form register throughout — never a reader-gendered participle.

**Acceptance criteria:** folded card matches the prototype (pink `--hi` card, rotated
icon box, display headline); `guest-lead-capture.spec.js` UI flow passes with the
regex update in UC-GX-011.

---

## UC-GX-010 g-dead — dead link (3 variants) and the status-404 card (Guest)

**Goal:** the dead-end screens per prototype `GDead` and `screenshots/16-shot.png`.

**Layout (both views):** brand header (subtitle **"Objednávka cez odkaz"** on
`/g/:token`, **"Vaša objednávka"** on the status page); below it a vertically centered
zone (`flex:1`, center both axes, padding 20 phone / 40 desktop) holding one `.card`
(padding 22/30, max-width 400, centered text, column gap 12, items centered):
`span.badge.danger` rotated −2°, 13px, padding `6px 14px`, containing
`NeoIcon name="lock"` + **"Slepá ulička"** · `h1.h-screen` 32/38 (title below) ·
`.sub` 14px (description) · `.sub` 13.5px (the common closing line).

**Variant mapping on `/g/:token` (`data-testid="guest-unavailable"`; the server
response is authoritative — GSO-T3 contract; prototype copy replaces the raw server
`e.message` the shipped card showed):**

| Server response | Title (`h-screen`) | Description (`.sub`) |
|---|---|---|
| **404** (unknown token) | Odkaz neexistuje | Tento odkaz sme nenašli. Skontrolujte, či je skopírovaný celý. |
| **410, `reason:'inactive'`** (link deactivated OR host deactivated) | Odkaz už nie je aktívny | Kolega, ktorý objednávku organizuje, tento odkaz deaktivoval. |
| **410, `reason:'closed'`** (cycle no longer open) | Objednávanie je uzavreté | Cyklus sa medzičasom uzamkol — objednávky už neprijímame. |
| anything else (network, 5xx) | Objednávka nie je dostupná (shipped fallback, kept) | server `e.message` |

Common closing line on all variants: **"Ak ste odkaz dostali od kolegu, požiadajte ho
o nový."**

- Reconciliation with GSO-T10's "the page cannot distinguish a lock from a dead link":
  that statement is about the **status page**, whose payload only clears `editable` —
  and the status page correspondingly never routes here; it shows the read-only banner
  (UC-GX-006) instead. On `/g/:token` the discrimination above is safe because the
  server names the reason explicitly (404 / 410-`inactive` / 410-`closed`).

**Status-page 404 (`data-testid="guest-status-unavailable"`, the pair does not
resolve — GSO-T4's 404-only read resolver, incl. a cross-link `orderToken`):** same
centered dead-card composition (badge "Slepá ulička" included); title **"Objednávka sa
nenašla"**; description keeps the shipped copy: server `e.message` line, then
**"Skontrolujte, či je odkaz skopírovaný celý. Ak nie, požiadajte kolegu, ktorý
objednávku organizuje."** The prototype does not design this screen — recorded as a
composition decision (reuse g-dead's visual), not new behavior.

**Acceptance criteria:** 378 px side-by-side with `16-shot.png` (card floats centered
in the halftone background, rotated danger badge with padlock); the three variants
selectable in the live prototype match; dead-link e2e (`guest-order.spec.js` 404/410
paths asserting `guest-unavailable`) stays green — titles are unchanged from shipped,
only descriptions change and no spec pins those.

---

## UC-GX-011 Sanctioned e2e updates + verification (Guest, Admin — invariance)

**Goal:** the exhaustive list of spec updates this module's DOM/copy changes require
(01-architecture: selectors update only when the spec says so — this is that section),
and the fidelity procedure.

**Spec updates (exhaustive — anything beyond this list is a regression, not an
update):**

1. `guest-lead-capture.spec.js:470` — `toContainText(/nabudúce/i)` →
   `/objednať sami/i` (conflict #2).
2. `guest-order.spec.js:875` and `guest-status.spec.js:650` — `payment-reference` now
   lives inside the Platba modal: open it first (confirmation: assert within the
   auto-opened dialog before closing it; status: click `open-payment`), then
   `getByTestId('payment-reference')` (on the copy-row root) `toContainText(...)`.
3. `guest-order.spec.js:877` — `getByTestId('guest-status-url').inputValue()` → the
   value is now the copy-row's text: read `textContent` of
   `getByTestId('guest-status-url')` (or its `.val` child); it is no longer an
   `<input>`.
4. `guest-order.spec.js:888–893` — copy-button flips assert "Skopírované!" (with the
   exclamation mark) and target the buttons as
   `getByTestId('guest-status-url').getByRole('button')` /
   `getByTestId('payment-reference').getByRole('button')`; the standalone
   `copy-status-url` / `copy-reference` testids are retired with the old markup.
   The two-button independence assertion (only the clicked row flips) is kept —
   status-URL row on the page vs. reference row inside the modal.
5. `guest-admin-view.spec.js:694–695` — `paid-locked` no longer exists (conflict #5):
   re-pin the paid-frozen state as `status-paid` contains "Zaplatené", `start-edit`
   has count 0, and `cancel-order` (the ghost direct cancel) is visible.

**Everything else is pinned to survive without edits** — the full testid inventory
this module preserves: `guest-unavailable`, `guest-status-unavailable`,
`guest-confirmation`, `guest-status`, `guest-name/phone/email`, `guest-submit`,
`checkout-error`, `open-checkout`, `cart-total`, `product-{id}`,
`inc-/dec-/qty-{variant}`, `inc-/dec-/qty-unit-{id}`, `guest-status-url`,
`payment-reference`, `status-paid`, `status-delivered`, `status-item`, `status-total`,
`status-cancelled`, `status-readonly`, `status-error`, `start-edit`, `open-payment`,
`edit-total`, `edit-error`, `abort-edit`, `save-edit`, `cancel-order`, `keep-order`,
`confirm-cancel-order`, `invite-cta`, `invite-cta-open`, `invite-name/phone/email`,
`invite-error`, `invite-submit`, `invite-done`, `invite-requested`; plus
`getByRole('dialog')` (NeoModal keeps `role="dialog"`) and the "Zavrieť" /
"Ponechať" / "Zrušiť objednávku" button names.

**Verification procedure (per UC-DS-014):**

- Fidelity: Playwright screenshots at 378 px (and 1180 px) of g-order, checkout,
  g-confirm, Platba, g-status ×4, g-dead ×3, side-by-side with screenshots 09–12 and
  14–16 and the live prototype (editable state — see the 13-shot note in the header).
  Recorded in the task PR; no visual-regression CI exists.
- Behavior: full e2e suite green with exactly the updates above; backend untouched
  (`git diff --stat backend/` empty); `api.js` and `lib/guest-cart.js` unchanged.
- Admin invariance: no admin view references `pp-*`, `neo/` components or theme
  classes; `/admin` screenshots identical before/after.
- The localStorage contract: submit on `/g/:token` then reload → the stored
  `gorifi_guest_orders[token]` entry round-trips exactly as before the restyle.

---

## Deliverables summary (files this module creates/edits)

| Path | Action |
|---|---|
| `frontend/src/views/GuestOrder.vue` | edit — g-order + g-confirm + checkout restyle (UC-GX-001, 003, 004, 010) |
| `frontend/src/views/GuestOrderStatus.vue` | edit — g-status read + edit + cancel confirm (UC-GX-006, 007, 008, 010) |
| `frontend/src/components/GuestProductGrid.vue` | edit — neo grid (UC-GX-002) |
| `frontend/src/components/GuestInviteRequest.vue` | edit — CTA restyle (UC-GX-009) |
| `frontend/src/components/PaymentModal.vue` | edit — neo shell + reference row (UC-GX-005) |
| `frontend/src/components/GuestBrandHeader.vue` | new — shared guest chrome (UC-GX-001) |
| `frontend/src/components/neo/NeoStepper.vue` | edit — testid/incDisabled prop seam back to 02 (UC-GX-002; visual no-op) |
| `e2e/tests/guest-order.spec.js`, `guest-status.spec.js`, `guest-lead-capture.spec.js`, `guest-admin-view.spec.js` | edit — only the UC-GX-011 list |

**Not touched:** anything under `backend/`, `frontend/src/api.js`,
`frontend/src/lib/guest-cart.js`, `frontend/src/router.js`, all admin views, all
`components/ui/*`.
