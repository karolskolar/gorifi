# 04 — Friend order screen: f-order, f-order-locked, f-bakery

> Scope: The redesign of `frontend/src/views/FriendOrder.vue` — the friend's ordering
> screen for one cycle (`/cycle/:cycleId`) in all three prototype states: coffee order
> (f-order), locked cycle (f-order-locked) and bakery cycle (f-bakery). Covers the
> brand chrome composition for this screen, status banners, the **shell** of the
> "Moja objednávka ⇄ Kolegovia" main switch (tabs + badge), the sticky `.cat-tabs`
> category strip, coffee and bakery product cards with `.vbox` variant boxes and the
> stock-limit bar, the sticky `.cartbar`, and the modals this screen opens: Spôsob
> prevzatia, Hotovo! (success with inline payment), Zrušiť objednávku confirm, and the
> leave-confirmation modal. This is a **re-skin plus the handoff's UX changes — no API,
> schema or business-logic change**; every behavior rule below restates the shipped
> contract that must survive the restyle. Out of scope (handoffs): the Kolegovia panel
> CONTENT — suborder cards, share dialog, empty states (→ `05-colleagues-panel.md`;
> this module only specifies the tab shell and where the panel mounts); `PaymentModal.vue`
> internals — the standalone Platba modal opened by the footer's Zaplatiť (→
> `06-guest-flow.md` restyles it; this module only pins when it opens and with what
> props); all shared primitives, tokens and classes (→ `02-design-system.md`); the
> portal and its cycle cards (→ `03-friend-login-portal.md`).
> Actors: Friend (host) — the only actor on this screen; orders for themselves, sees the
> Kolegovia tab shell. Guest — never sees this screen (their surface is module 06).
> Admin — not present; admin views must remain pixel-identical (02 invariant).
> Sources: `docs/design/friends-portal-redesign/README.md` (§Screens items 3, 5, 6,
> §Shared modals, §Interactions & Behavior, §Business rules),
> `docs/design/friends-portal-redesign/friends/order.jsx` (reference implementation —
> `FOrder`, `CoffeeCard`, `BakeryCard`, `VariantBox`, `PickupModal`, success + cancel
> modals), `friends/ui.jsx` (`ProductImg`, `RevolutBtn`), `friends/data.js` (demo
> shapes), `friends/theme.css` (class contract), repo `frontend/src/views/FriendOrder.vue`
> + `frontend/src/api.js` + `backend/src/routes/orders.js` (behavior contract), repo
> `CLAUDE.md` (auto-save, dismissable notifications, pickup, Packeta, bakery variants,
> 2026-08-07 tab-split invariants), `e2e/tests/mobile-no-h-overflow.spec.js` +
> `guest-host-view.spec.js` (pinned DOM hooks). The handoff bundle is canonical for
> visuals and copy; repo code is canonical for behavior. The most recent decision wins.
> **Design reference:** `screenshots/03-shot.png` (coffee order, phone),
> `07-shot.png` (locked), `08-shot.png` (bakery), `17-shot.png` (desktop 760px);
> live prototype `Podpultovka Friends.html` → screens "Objednávka — moja",
> "Objednávka — uzamknutá", "Objednávka — pekáreň".

---

## Resolved conflicts (recency / canonicity)

1. **Kolegovia tab badge semantics.** The prototype always renders the amber
   `.tabbadge.pending` with the not-yet-delivered count (`subTotals.pendingDelivery`),
   even on an open cycle. The shipped rule (CLAUDE.md 2026-08-07, pinned by
   `guest-host-view.spec.js`) is: **count of colleagues at rest; the not-yet-handed-over
   count only when the cycle is locked; no badge when the count is 0.** Behavior is
   repo-canonical → shipped **semantics** win; prototype **visuals** win: the resting
   badge renders as plain `.tabbadge` (white/ink — the violet Tailwind badge dies with
   the old skin), the locked-pending badge as `.tabbadge.pending` (amber). See UC-FO-003.
2. **Category tab names.** The prototype hardcodes Espresso / Filter / Filter Special /
   Brew Bags / Nespresso (and Slané / Sladké). Production derives tabs from the
   `purpose` field of the cycle's product snapshot (repo `availablePurposes`) — the
   prototype list is demo data. The derivation and ordering rule are pinned in UC-FO-004.
3. **Main switch on bakery cycles.** The prototype renders the tabgroup only for coffee
   (`{!bakery && …}`). The repo renders the Kolegovia panel for every cycle type — guest
   links are not cycle-type-gated, and hiding the tab would hide a bakery host's
   hand-over checklist. Behavior is repo-canonical → **the switch renders on bakery
   cycles too**; the prototype's omission is demo simplification.
4. **Success-modal copy.** The repo distinguishes "Vaša objednávka bola úspešne
   odoslaná!" vs "Vaša objednávka bola aktualizovaná!". The prototype uses one static
   subtitle for both paths. Prototype copy is final → both first submit and update show
   **"Objednávka bola odoslaná. Môžete ju upraviť až do uzamknutia cyklu."**; the
   "aktualizovaná" variant is **dropped**.
5. **Dirty-warning dismissability.** The prototype's cartbar warning has no close
   affordance; the shipped behavior (CLAUDE.md 2026-02-03) lets the user dismiss it, and
   it reappears on the next cart change. Behavior is repo-canonical → the dismiss stays:
   the `.banner.warn.slim` gains a right-aligned ✕ (`NeoIcon name="close"`, size 14) —
   a recorded visual addition to the prototype.
6. **Stock bar units and math.** Prototype copy is in kg ("Zostáva 1.25 kg z 5 kg");
   the repo computes in grams and live-subtracts the current cart
   (`getRemainingGrams`). Resolution: **repo math, kg display** — see UC-FO-006.
7. **Per-category page tint.** The repo tints the page background per active tab
   (`bg-stone-200`, `bg-sky-100`, …). The prototype background is uniform `--bg`
   everywhere. Prototype wins → the `backgroundClass` mechanism is **dropped**.
8. **Bakery card image.** The repo bakery card has a left image column; the prototype
   `BakeryCard` (and `08-shot.png`) has **no image**. Prototype wins → bakery cards
   render no image (the snapshot's `image` column simply goes unused here).
9. **Footer total.** The prototype sums product lines only (its demo has no delivery
   fee on an order). The repo's footer shows `paymentTotal = cartTotal + delivery_fee`.
   Behavior/repo wins → **`paymentTotal`**, and the delivery-fee line stays in the cart
   `<details>` (without the repo's 📦 emoji — the design language has no emoji;
   plain text "Doručenie Packetou").
10. **Cart-lines grouping.** The repo groups cart lines under colored purpose headers;
    the prototype renders a flat `.lines` list. Presentation → prototype wins: **flat
    lines**, format `{name} ({size}) ×{qty}` + mono total. The purpose grouping
    (`groupedCartItems`) is dropped from this view.
11. **Save-as-default checkbox initial state.** The prototype renders it statically
    checked; the repo resets `savePacketaAsDefault = false` on every modal open.
    Behavior wins → **unchecked on open**. (The feature itself is supported today via
    `api.updateFriendProfile(id, { packeta_address })` — no open dependency.)
12. **"Objednávka ešte nebola odoslaná." banner, leave modal, "Ukladám…"/"Odosielám…"
    indicators.** All repo-only (the prototype is silent on them). Behavior wins → all
    three survive, restyled with theme classes (UC-FO-008/009/013).

---

## UC-FO-001 Screen shell & brand chrome (Friend)

**Goal:** `FriendOrder.vue`'s root becomes an `.app` scope with the brand chrome, the
standard page column, and the neo loading/error states; all data flow stays as shipped.

**Preconditions:** modules 02 (primitives, `friends-theme.css`) and 03 (login/portal —
the auth restore this view depends on) landed.

**Main flow:**

1. Root element gets `class="app"` and `flex flex-col` with `min-height:100vh`
   (theme `.app` provides it). All shadcn imports (`Card`, `Button`, `Alert`, `Badge`,
   `Tabs*`, `Dialog*`) are removed from this view (02 UC-DS-004 rule 4); `GuestShareDialog`,
   `GuestSubOrders`, `PaymentModal` imports stay (their internals are modules 05/06).
2. First child: `BrandChrome` —
   - `#leading`: `span.back` with `NeoIcon name="back"`, click → `goBack()` (which keeps
     the shipped unsaved-changes guard, UC-FO-013).
   - `title` = `cycle.name`; `subtitle` = the friend's identity line (see OPEN below).
   - `#trailing`: locked/planned/completed → `span.chip` with `NeoIcon name="lock"`;
     open → `span.chip.acc` with text **"Otvorené"**.
   - `ticker`: open → `"+++ OBJEDNÁVKY OTVORENÉ +++ NEHOVOR O TOM NAHLAS +++"`;
     locked → `"+++ OBJEDNÁVKY UZAMKNUTÉ +++ DRŽ JAZYK ZA ZUBAMI +++"` (verbatim).
   - The chrome is NOT sticky and scrolls away (02 UC-DS-005/006). This **removes** the
     current sticky header — the top edge belongs to `.cat-tabs` (UC-FO-004).
3. Page column below the chrome: `max-width:760px`, centered, `width:100%`, padding
   **16px phone / 28px desktop**, `padding-bottom:8px`, vertical `gap:14px`,
   `flex:1` (prototype inline layout).
4. Loading state: centered `.sub` text "Načítavam..." (copy unchanged). Fatal error
   state (error && !friend): `.banner.danger` with `<b>Chyba:</b> {error}` + a
   `.btn` "Späť na zoznam cyklov" → `goBack()`.
5. `document.title` logic, `onMounted` auth restore/redirect, `loadOrderData()`,
   pickup-locations + payment-settings fetches: **unchanged**.

**Business rules:**

- The auth-restore contract stands: a hard load of `/cycle/:id` without a session
  bounces to `/` (FriendPortal owns restore). Do not "fix" this while restyling —
  `mobile-no-h-overflow.spec.js` navigates through the portal for exactly this reason.
- `OPEN:` the prototype's appbar subtitle is `"Lego · X42KPGZZ"` (friend name · code),
  but `GET /orders/cycle/:cycleId/friend/:friendId` returns only
  `friend: {id, name, packeta_address}`, and `friends.js` strips `invite_code` from
  every friend response. No API change is allowed. Proposed default: render the
  **name only** as the subtitle; if module 03 establishes a client-side source for the
  code shown on the portal appbar (same "name · code" pattern), reuse it here.
  Needs the orchestrator's confirmation of what the prototype's `code` maps to.

**Acceptance criteria:**

- Side-by-side with `03-shot.png`: black appbar with back chevron, cycle name in display
  caps, rotated "OTVORENÉ" chip, hazard tape, ticker with the open-cycle copy.
- Scrolling the page scrolls the chrome away; only `.cat-tabs` (top) and `.cartbar`
  (bottom) remain pinned. No horizontal overflow at 320px.

---

## UC-FO-002 Status banners & message placement (Friend)

**Goal:** the page-level banners in prototype form, in the shipped priority order.

**Main flow — first content row inside the page column, exactly one of:**

| Condition (shipped, unchanged) | Renders |
|---|---|
| `isLocked` | `.banner.warn`: `<b>Objednávky sú uzamknuté.</b> Už nie je možné meniť objednávku.` |
| `isSubmitted && !isLocked && cartItems.length > 0 && !hasUnsubmittedChanges` | `.banner.ok`: `<b>Vaša objednávka bola odoslaná!</b> Stále ju môžete upraviť až do uzamknutia.` |
| otherwise | nothing |

Below it (independent, unchanged conditions): transient `error` → `.banner.danger.slim`
with the message; `successMessage` ("Košík bol uložený", 3s) → `.banner.ok.slim`.

**Business rules:**

- The prototype hides the green banner while `dirty` (`submitted && !dirty && lines>0`).
  The repo equivalent of `dirty` is `hasUnsubmittedChanges` — adopt the prototype
  behavior: **the green banner yields while unsent changes exist** (the cartbar warning
  carries the state instead, UC-FO-009). This is a handoff UX change, in contract.
- Banners sit ABOVE the main switch — a submit can fail from either tab and the message
  must be visible on both (shipped comment, preserved).
- Each `.banner` carries its `span.dot` as the first child (theme contract).

**Acceptance criteria:** green banner matches `03-shot.png` (ok-soft fill, ink border,
square dot); warn banner matches `07-shot.png`; adding a cart item on a submitted order
swaps green banner → cartbar warning, reverting the change swaps back.

---

## UC-FO-003 Main switch — tabgroup shell + colleague badge (Friend)

**Goal:** the "Moja objednávka ⇄ Kolegovia" segmented switch in `.tabgroup` form, with
the shipped badge semantics and every 2026-08-07 invariant intact. **Shell only** — the
Kolegovia panel's content is module 05's.

**Main flow:**

1. Replace the hand-rolled Tailwind switch with:

```html
<div class="tabgroup" role="tablist" aria-label="Objednávka alebo kolegovia">
  <span class="tab" :class="{ on: mainTab === 'own' }" role="tab" id="tab-own"
        aria-controls="panel-own" :aria-selected="mainTab === 'own' ? 'true' : 'false'"
        data-testid="main-tab-own" @click="mainTab = 'own'">Moja objednávka</span>
  <span class="tab" :class="{ on: mainTab === 'guests' }" role="tab" id="tab-guests"
        aria-controls="panel-guests" :aria-selected="…" data-testid="main-tab-guests"
        @click="mainTab = 'guests'">
    Kolegovia
    <span v-if="guestBadgeCount > 0" class="tabbadge"
          :class="{ pending: guestBadgeIsPending }" data-testid="guest-tab-badge"
          :title="guestBadgeIsPending
            ? 'Toľkým kolegom ste ešte neodovzdali tovar'
            : 'Toľko kolegov si objednalo cez váš odkaz'">{{ guestBadgeCount }}</span>
  </span>
</div>
```

2. The two panels keep their shipped structure verbatim:
   `div#panel-own[role=tabpanel]` and `div#panel-guests[role=tabpanel]`, both **`v-show`**.
   `#panel-guests` hosts the module-05 content (`GuestSubOrders` with `:ready="!!friend"`,
   the share card, `GuestShareDialog`) — none of it re-specified here.

**Business rules (hard constraints, all pre-existing):**

- **`v-show`, never `v-if`** — `GuestSubOrders` must stay mounted on both tabs or its
  `summary` emit never fires and the badge appears only after the tab is opened.
- `mainTab` defaults to `'own'` on every load **including locked cycles**; not
  persisted, not in the URL.
- Badge (resolved conflict #1): `guestBadgeIsPending = isLocked && pendingDelivery > 0`;
  `guestBadgeCount = pending ? pendingDelivery : count`; no badge at count 0; the tab
  itself stays visible with zero colleagues (it is where sharing lives). Fed exclusively
  by `GuestSubOrders`' `summary` emit (stored in the parent's `guestSummary` state) —
  this view never fetches guest data itself.
- The switch renders on **bakery cycles too** (resolved conflict #3).
- The switch is **not sticky** and must **not scroll**: `.tabgroup` is a 2-column
  1fr/1fr grid. It must fit at **320px** with zero internal overflow
  (`mobile-no-h-overflow.spec.js` asserts `scrollWidth − clientWidth ≤ 0` on
  `getByRole('tablist').first()` — the switch must remain the FIRST tablist in the DOM,
  i.e. render above `.cat-tabs`). If "Moja objednávka" at theme type (700/14px) overflows
  a 320px half-cell, the screen may shrink the tab's font-size/padding below 360px
  viewport width — utility overrides on `.tabgroup .tab` only, never on `.tab` globally.
- Pinned test ids that must not change: `main-tab-own`, `main-tab-guests`,
  `guest-tab-badge` (badge asserted by exact text, e.g. `'2'` → locked → `'1'`).

**Acceptance criteria:** matches `03-shot.png` — highlight-pink `.tabgroup` frame with
3px ink border + 3px shadow, active segment white with 2px ink border, badge as a mono
22px pill; `guest-host-view.spec.js` tab-split tests stay green unmodified.

---

## UC-FO-004 Category strip — `.cat-tabs` (Friend)

**Goal:** the sticky, scroll-snapping, edge-fading category strip, fed from the real
product purposes.

**Main flow:**

1. Inside `#panel-own`, above the product list:

```html
<div class="cat-tabs" data-testid="purpose-tabs" role="tablist">
  <span v-for="purpose in availablePurposes" :key="purpose" role="tab"
        class="tab" :class="{ on: purpose === activeTab }"
        :aria-selected="…"
        @click="(e) => { snapTab(e); activeTab = purpose }">{{ purpose }}</span>
</div>
```

2. The product list for the active purpose renders below in a
   `flex flex-col` with `gap:16px` — **only the active purpose's cards** (replaces the
   radix `TabsContent` panels; same one-visible-at-a-time behavior).

**Business rules:**

- **Purposes are data-derived** (resolved conflict #2): `availablePurposes` = keys of
  `groupedProducts` (i.e. distinct `product.purpose`, `'Ostatne'` fallback), ordered
  **Espresso, Filter, Kapsule first, then the rest in encounter order** — the shipped
  rule, unchanged. Bakery cycles yield e.g. Slané/Sladké the same way. The prototype's
  "Filter Special / Brew Bags / Nespresso" are admin-entered purpose values, not code.
- `activeTab` initialization keeps the shipped watcher (first available purpose;
  re-picks when the current one disappears).
- **Single-purpose fallback** (shipped): when `availablePurposes.length === 1`, render
  no strip — just the cards. `mobile-no-h-overflow.spec.js` seeds ≥4 purposes, so the
  strip is present there.
- Tap-to-center: `snapTab(e)` from `frontend/src/lib/snap-tab.js` (02 UC-DS-012) —
  `parent.scrollTo`, never `scrollIntoView`.
- Geometry from theme.css, not re-derived: `position:sticky; top:0; z-index:40`, hidden
  scrollbar, `scroll-snap-type:x proximity`, per-tab `scroll-snap-align:start`,
  right-edge fade via the sticky `::after` gradient (28px). The strip scrolls **within
  itself**; the page never scrolls horizontally (both asserted by
  `mobile-no-h-overflow.spec.js` via `data-testid="purpose-tabs"` — the test id moves
  onto this element and must not be dropped; tabs must expose `role="tab"` because the
  spec counts `strip.getByRole('tab')`).
- The old per-category page tint and colored `TabsTrigger` classes are dropped
  (resolved conflict #7); active tab = `.tab.on` (magenta) only.
- One sticky bar per edge (02 UC-DS-005): with the appbar no longer sticky, `.cat-tabs`
  owns the top edge alone. The strip only exists inside `#panel-own`, so the Kolegovia
  tab has no top sticky bar — correct per prototype.

**Acceptance criteria:** at 378px the strip shows ~4.5 tabs with the right-edge fade
(`03-shot.png`); tapping a partially visible tab centers it with smooth scroll and
switches the product list; at 320px the document has zero horizontal overflow while the
strip itself has `scrollWidth > clientWidth`.

---

## UC-FO-005 Coffee product card (Friend)

**Goal:** the neo coffee card: stretched bag image, roast + roaster badges, spec line,
mono tasting notes, variant boxes.

**Structure (per product of the active purpose):**

```html
<div class="card" :style="{ padding: phone ? '14px' : '18px' }">
  <div class="flex gap-[13px] items-stretch">
    <!-- .pimg: width 58px phone / 70px desktop, min-height = width, height:auto,
         align-self:stretch — the frame stretches to the description height -->
    <div class="pimg" style="…">
      <img v-if="product.image" :src="product.image"
           style="display:block;width:100%;height:100%;object-fit:cover" />
      <!-- no photo: the bare frame with its dark gradient; no .band/.cap/.lbl -->
    </div>
    <div class="flex-1 min-w-0">
      <div class="display" :style="{ fontSize: phone ? '19px' : '21px', lineHeight: 0.95 }">{{ product.name }}</div>
      <div class="flex flex-wrap gap-[6px] mt-2">
        <span v-if="product.roast_type" class="badge" style="font-size:11px;padding:2px 7px">{{ product.roast_type }}</span>
        <span v-if="product.roastery" class="badge acc-o" style="font-size:11px;padding:2px 7px">{{ product.roastery }}</span>
      </div>
      <div v-if="product.description1" class="sub" style="margin-top:7px;font-size:13px">{{ product.description1 }}</div>
      <div v-if="product.description2" class="mono" style="font-size:12.5px;color:var(--ink-faint);margin-top:2px">{{ product.description2 }}</div>
    </div>
  </div>
  <!-- stock bar (UC-FO-006), then variant grid -->
  <div class="grid gap-[10px] mt-[13px]" :style="{ gridTemplateColumns: variantCount > 1 ? '1fr 1fr' : '1fr' }">
    <!-- one .vbox per priced variant -->
  </div>
</div>
```

**Field group — variant boxes.** One `.vbox` per non-null price field of the product,
in this fixed order:

| price field | `variant` key (cart) | `.vsize` label |
|---|---|---|
| `price_150g` | `150g` | `150g` |
| `price_200g` | `200g` | `200g` |
| `price_250g` | `250g` | `250g` |
| `price_500g` | `500g` | `500g` |
| `price_1kg` | `1kg` | `1kg` |
| `price_20pc5g` | `20pc5g` | `20 ks × 5g` |

Each `.vbox`: `div.vrow` → `span.vsize` label + `span.vprice`
`applyMarkup(price).toFixed(2) + ' EUR'`; below it a `NeoStepper` with
`:model-value="getQuantity(product.id, variant)"`, `:disabled="isLocked"`, and an
update handler that routes through the shipped `increment`/`decrement`/`setQuantity`
logic (stock ceiling in UC-FO-006). `qty > 0` ⇒ the box gains **`.sel`** (3px ink
border, `3px 3px 0` magenta shadow, magenta price — theme-provided).

**Business rules:**

- Grid columns: `1fr 1fr` when the product has >1 priced variant, single `1fr`
  otherwise (prototype rule; replaces the repo's fixed `grid-cols-2` and the special
  capsule branch — a `20pc5g`-only product is simply a one-variant grid).
- Field mapping is fixed: `description1` = the spec line (`.sub`), `description2` = the
  tasting notes (mono, ink-faint). Pricing display always through `applyMarkup`
  (markup math unchanged — `Math.round(base × markup_ratio × 100) / 100`).
- Photo fallback (closes 02 UC-DS-013's OPEN): a product without an uploaded photo
  renders the **bare `.pimg` frame** — its built-in dark gradient, no `.band`/`.cap`/
  `.lbl` bag internals (they stay prototype-only). No placeholder icon.
- `NeoStepper` is the only quantity control; mutations apply to the cart instantly
  (README §Interactions); persistence policy is UC-FO-008's.

**Acceptance criteria:** card matches `03-shot.png` — display-caps name, two small
badges (plain + highlight `acc-o`), gray spec line, mono notes, two `.vbox`es side by
side; adding qty flips the box to `.sel` with magenta shadow and price; the `.pimg`
frame's height tracks the text block (items-stretch), 2px ink border, radius 8.

---

## UC-FO-006 Stock-limit bar & increment ceiling (Friend)

**Goal:** the availability bar on products with a `stock_limit_g`, and the stepper
ceiling — shipped math, prototype look.

**Main flow — rendered between the description row and the variant grid, only when
`availability[product.id]` exists:**

```html
<div class="flex items-center gap-[10px] mt-3">
  <div style="flex:1;height:10px;border:2px solid var(--nb-ink);border-radius:6px;overflow:hidden;background:#fff">
    <div :style="{ width: orderedPct + '%', height: '100%', background: 'var(--accent)' }"></div>
  </div>
  <span v-if="remaining === 0" class="mono" style="font-size:11.5px;white-space:nowrap;color:var(--danger)">Vypredané</span>
  <span v-else class="mono" style="font-size:11.5px;white-space:nowrap;color:var(--warn)">Zostáva {{ kg(remaining) }} z {{ kg(limit) }}</span>
</div>
```

**Business rules:**

- **Math is the shipped gram math, untouched** (resolved conflict #6):
  `remaining = getRemainingGrams(productId)` (server `remaining_g` minus grams already
  in the local cart via `getCartGramsForProduct`); `limit = stock_limit_g`;
  `orderedPct = min(100, (limit − remaining) / limit × 100)` — i.e. the fill includes
  the friend's own uncommitted cart, exactly as today.
- **Display is kg** (prototype copy): `kg(g) = (g/1000)` formatted with up to 2
  decimals, trailing zeros stripped, dot decimal, suffix `" kg"` — `250 → "0.25 kg"`,
  `1000 → "1 kg"`, `1250 → "1.25 kg"`. Fill is always accent magenta; the sold-out
  signal is the **"Vypredané"** label in danger red (repo state, kept), not a bar color.
- The stepper ceiling stays in the view (02 UC-DS-008 forbids a max in the primitive):
  the `+` path runs the shipped `canIncrement(productId, variant)` — an increment that
  would exceed `remaining_g` is **silently refused** (no error toast, matching shipped
  behavior). `variantGrams` mapping (`150g:150 … 20pc5g:100`) unchanged.
- `loadAvailability` (with `excludeFriendId`) and its non-critical failure mode
  unchanged. Bakery products never have availability rows today; the bar simply doesn't
  render (`'unit'` is zero-gram by contract — CLAUDE.md GSO-T3).

**Acceptance criteria:** a product at limit 5000g with 1250g remaining shows a 75%-full
magenta bar and mono "Zostáva 1.25 kg z 5 kg"; tapping `+` past the limit does nothing;
emptying the variant restores the bar and label live (cart-aware).

---

## UC-FO-007 Bakery branch — f-bakery (Friend)

**Goal:** the bakery card per prototype: name + weight, composition behind `<details>`,
unit-variant boxes; shipped variant grouping preserved.

**Structure (per group from the shipped `groupedBakeryProducts` — one card per
`source_bakery_product_id`, `_variants` = its snapshot rows):**

```html
<div class="card" :style="{ padding: phone ? '14px' : '18px' }">
  <div class="flex justify-between gap-[10px] items-baseline">
    <div class="min-w-0">
      <span class="display" :style="{ fontSize: phone ? '19px' : '21px', lineHeight: 0.95 }">{{ group.name }}</span>
      <span v-if="group.description2" class="sub" style="font-size:13px;margin-left:8px">{{ group.description2 }}</span>
    </div>
    <span v-if="group._variants[0].weight_grams" class="mono sub"
          style="font-size:12px;white-space:nowrap">{{ group._variants[0].weight_grams }} g</span>
  </div>
  <div v-if="group.description1" class="sub" style="font-size:13px;margin-top:6px">{{ group.description1 }}</div>
  <details v-if="group.composition" style="margin-top:8px">
    <summary class="sub" style="cursor:pointer;font-size:13px">Zloženie</summary>
    <div class="sub" style="font-size:13px;margin-top:4px">{{ group.composition }}</div>
  </details>
  <div class="grid gap-[10px] mt-3" :style="{ gridTemplateColumns: group._variants.length > 1 ? '1fr 1fr' : '1fr' }">
    <!-- one .vbox per variant row -->
  </div>
</div>
```

**Field group — bakery variant box:** `.vsize` = `variant_label` (fallback `"1 ks"`
when null — single-variant legacy products); `.vprice` =
`applyMarkup(v.price_unit).toFixed(2) + ' EUR'`; stepper keyed `(v.id, 'unit')`.
Selection is **per-vbox** (`getQuantity(v.id,'unit') > 0` ⇒ `.sel`), replacing the
repo's whole-card ring.

**Business rules:**

- Grouping logic (`source_bakery_product_id`, `_variants`, `getGroupQuantityTotal`)
  and the `'unit'` cart-variant key: **unchanged** — this is the CLAUDE.md 2026-04-19
  contract.
- Weight: the card-level weight is the **first variant row's `weight_grams`** (the
  snapshot carries it per variant; `cycles.js:230`), rendered `"{n} g"` mono; omitted
  when null. Per-variant weights beyond the first are not displayed (prototype shows
  one weight per card).
- `description2` (subtitle) stays next to the name (repo feature, kept — prototype has
  no subtitle; recorded, not a conflict since prototype is silent).
- No image column (resolved conflict #8). No stock bar (no availability for bakery).
- Slané/Sladké come through UC-FO-004's purpose derivation — nothing bakery-specific in
  the tab strip. The main switch renders here too (resolved conflict #3).
- Category-colored backgrounds/tab classes for Slané/Sladké are dropped with
  `backgroundClass` (resolved conflict #7).

**Acceptance criteria:** matches `08-shot.png` — "ŠUNKOVO-SYROVÁ BAGETA" display caps
with mono "190 g" right-aligned at baseline, "▸ Zloženie" fold, two `.vbox`es
("1 KS 3.20 EUR" / "3 KS 8.90 EUR") with steppers; opening Zloženie reveals the
composition text; quantities on two variants of one product select both boxes
independently.

---

## UC-FO-008 Cart model, auto-save & dirty tracking (Friend — behavior preservation)

**Goal:** none of this changes; it is restated because every UC above hangs off it and
the implementer must not regress it while rewriting the template.

**Business rules (all shipped; the restyle must keep each one testably intact):**

- Cart map `productId-variant → qty` (note: **repo key separator is `-`**, not the
  prototype's `|` — keep the repo's).
- **Auto-save matrix:** no order yet → NO auto-save (cart lives only in memory until
  explicit submit); draft order exists → debounced 500ms auto-save; submitted order →
  NO auto-save (changes wait for "Aktualizovať"). Auto-save is suppressed during
  initial load (`initialLoadComplete` 100ms latch) and when locked.
- Order creation happens **only** on explicit save/submit
  (`PUT /orders/cycle/:cycleId/friend/:friendId` creates on demand); emptying the cart
  on save deletes the order server-side.
- `lastSubmittedCart` snapshot at submit; `hasUnsubmittedChanges` = submitted && cart
  differs from snapshot; `hasUnsavedChanges` additionally covers "no order but cart has
  items". Status preserved on item updates (server keeps `submitted`).
- `changesNotificationDismissed` resets on every cart change (dismissed warning
  reappears on the next edit).
- `setQuantity`/`increment`/`decrement` no-op when `isLocked`; qty ≤ 0 deletes the key;
  reactivity via `cart.value = { ...cart.value }`.
- `guestSummary`, `mainTab`, and the `ready`-gate wiring to `GuestSubOrders` unchanged
  (UC-FO-003 / module 05).

**Acceptance criteria:** the existing behavior-asserting e2e specs
(`guest-host-view.spec.js` order interactions, `public-flow.spec.js` if applicable)
pass unmodified; manual check of the matrix: fresh cycle + items + navigate away →
leave modal (nothing persisted); draft + item change → network PUT after ~500ms;
submitted + item change → no PUT until Aktualizovať.

---

## UC-FO-009 Sticky cart footer — `.cartbar` (Friend)

**Goal:** the sticky bottom bar: deadline, item count, total, actions, inline dirty
warning, cart lines behind `<details>`.

**Structure (sits OUTSIDE both tab panels — visible and functional on both tabs; a
direct child of the `.app` flex column, after the page column):**

```html
<div class="cartbar">
  <!-- 1. not-yet-submitted notice (repo-only, kept): -->
  <div v-if="!isLocked && cartItems.length > 0 && !isSubmitted"
       class="banner warn slim" style="margin-bottom:8px">
    <span class="dot"></span><span><b>Objednávka ešte nebola odoslaná.</b></span>
  </div>
  <!-- 2. dirty warning (dismissable — resolved conflict #5): -->
  <div v-else-if="!isLocked && hasUnsubmittedChanges && !changesNotificationDismissed"
       class="banner warn slim" style="margin-bottom:8px">
    <span class="dot"></span>
    <span style="flex:1"><b>Zmeny neboli odoslané.</b> Stlačte „Aktualizovať“.</span>
    <span @click="changesNotificationDismissed = true" title="Zavrieť"
          style="cursor:pointer;flex-shrink:0"><NeoIcon name="close" :size="14" /></span>
  </div>
  <div class="meta">
    <span class="deadline">Objednávka do: {{ cycle.expected_date }}</span>
    <span class="sub" style="font-size:13px">Položiek: {{ cartItems.length }}</span>
  </div>
  <div class="meta" style="margin-top:2px">
    <span class="sum">Celkom: {{ paymentTotal.toFixed(2) }} EUR</span>
    <span v-if="autoSaving" class="sub" style="font-size:12px">Ukladám…</span>
  </div>
  <div v-if="!isLocked" class="actions">
    <button class="btn danger sm" :disabled="saving || cartItems.length === 0"
            @click="cancelOrder">Zrušiť</button>
    <button v-if="isSubmitted && hasPaymentSettings" class="btn ok sm"
            @click="showPaymentModal = true">Zaplatiť</button>
    <button class="btn accent sm" :disabled="saving || cartItems.length === 0"
            @click="submitOrder">{{ saving ? 'Odosielam…' : (isSubmitted ? 'Aktualizovať' : 'Odoslať') }}</button>
  </div>
  <details>
    <summary>Zobraziť položky v košíku</summary>
    <div class="lines">
      <span v-if="cartItems.length === 0" class="sub">Košík je prázdny</span>
      <div v-else class="ln" v-for="item in cartItems" :key="item.key">
        <span>{{ item.product_name }} ({{ lineSize(item) }}) ×{{ item.quantity }}</span>
        <span class="mono">{{ item.total.toFixed(2) }} EUR</span>
      </div>
      <div v-if="order?.delivery_fee" class="ln">
        <span>Doručenie Packetou</span>
        <span class="mono">{{ order.delivery_fee.toFixed(2) }} EUR</span>
      </div>
    </div>
  </details>
</div>
```

**Business rules:**

- `.cartbar` is `position:sticky; bottom:0; z-index:50` (theme) — replaces the current
  `fixed` bar and its `h-48` spacer hack (both removed; sticky needs no spacer when the
  bar is the flex column's last child).
- Deadline row renders only when `cycle.expected_date` is set; value verbatim from the
  API (no reformatting), no emoji.
- **Total = `paymentTotal`** (incl. `delivery_fee` — resolved conflict #9), in the
  `.sum` display style, not mono. Item line totals and the fee line are mono.
- `lineSize(item)` = `variant_label` when set, else `'ks'` for `'unit'`, else the
  variant string — the shipped label logic, verbatim. Lines are **flat** (resolved
  conflict #10), `×` multiplication sign.
- Button semantics unchanged: Zrušiť → UC-FO-012 modal; Zaplatiť (only when submitted
  AND payment settings exist) → opens `PaymentModal` with
  `{amount: paymentTotal, reference: paymentReference, iban, revolutUsername}` (its
  internals → module 06); Odoslať/Aktualizovať → `submitOrder()` (routing in UC-FO-010).
- Locked: the `.actions` row is absent entirely (UC-FO-014); the `<details>` cart lines
  and meta rows remain.
- The warning banners live INSIDE the cartbar (prototype), not above the page — at most
  one of the two shows, and neither shows when locked.
- `.cartbar .actions .btn { flex:1; min-height:46px }` comes from the theme — three
  buttons share the row equally; do not override widths.

**Acceptance criteria:** matches `03-shot.png` footer — 4px ink top border with magenta
`0 -6px 0` shadow, mono uppercase deadline, 22px display "Celkom:", ▸/▾ summary
toggle; the bar is present and identical on the Kolegovia tab; dismissing the dirty
warning hides it until the next cart change; `guest-host-view.spec.js`'s
`getByText('Celkom:')` assertion stays green.

---

## UC-FO-010 Spôsob prevzatia modal (Friend)

**Goal:** the delivery-method modal in neo form, with the shipped 4-scenario logic,
pre-selection, and save-as-default.

**Composition:** `NeoModal` — `title="Spôsob prevzatia"`,
`subtitle="Vyberte, ako chcete dostať objednávku."`; footer: `button.btn` "Zrušiť"
(close, no submit) + `button.btn.accent` "Potvrdiť a odoslať"
(`:disabled="deliveryMethod === 'packeta' && !packetaAddress.trim()"`).

**Field group — the RadioRow pattern (local to this screen, prototype-exact):** a
`label.card.flat` with `padding:11px 13px`, flex row, gap 10;
checked ⇒ `border-color: var(--nb-ink); background: var(--accent-soft)`,
unchecked ⇒ `border-color: rgba(10,10,10,0.3); background:#fff`. Leading radio dot:
18×18 span, `border-radius:50%`, 3px ink border, fill `var(--accent)` when checked
else white. The native `<input type="radio">` stays in the DOM visually hidden
(keyboard/AT — v-model unchanged).

**Main flow — scenario logic (shipped, unchanged):**

| Scenario | Modal content |
|---|---|
| no pickup locations, no parcel | **no modal** — `submitOrder()` calls `doSubmitOrder()` directly |
| pickup only | no method radios; the pickup-locations section only |
| parcel only | method radios "Doručenie Packetou (+fee)" and **"Bez doručenia (vyzdvihnem osobne)"** (repo copy, kept) |
| both | method radios `<b>Osobný odber</b>` and `<b>Doručenie Packetou</b> <span class="sub">(+{{ cycle.parcel_fee.toFixed(2) }} EUR)</span>` |

Pickup section (visible when `deliveryMethod === 'pickup'` && locations exist; top
border `2px solid rgba(10,10,10,0.12)`, padding-top 12): one RadioRow per location —
`<b>{{ loc.name }}</b> <span class="sub">{{ loc.address }}</span>` — then RadioRow
**"Iné"** (`selectedPickupLocationId = null`); when Iné is selected, an `.inp` input
`placeholder="Poznámka (voliteľné)"` bound to `pickupLocationNote`.

Packeta section (when `deliveryMethod === 'packeta'`; same top border): `.field-lbl`
**"Adresa výdajného miesta *"** + `.inp` bound to `packetaAddress`,
`placeholder="napr. Z-BOX Hlavná 15, Bratislava"`; below it a label row with
`NeoCheckbox` + **"Uložiť ako predvolenú adresu"** bound to `savePacketaAsDefault`
(default **unchecked** — resolved conflict #11).

**Business rules (all shipped, unchanged):**

- Pre-selection on open: existing `packeta_address` on the order → packeta + that
  address; existing `pickup_location_id` → pickup + that location; existing
  `pickup_location_note` → pickup + Iné + the note; otherwise pickup if locations exist
  else packeta, with `packetaAddress` pre-filled from `friend.packeta_address`.
- Confirm: when packeta && save-as-default && address non-empty →
  `api.updateFriendProfile(friend.id, { packeta_address })` (failure non-blocking);
  then close and `doSubmitOrder()` with the shipped `pickupData` payload
  (`use_parcel_delivery`, mutually-exclusive pickup/packeta fields).
- **Routing (README §Interactions):** `submitOrder()` opens this modal on **every**
  explicit submit when scenario ≠ 1 — first submit AND Aktualizovať (the shipped
  behavior; pre-selection makes updates one-tap). The prototype's "later submits are
  direct" refers to not re-asking what is already answered — satisfied by
  pre-selection, not by skipping the modal. Both paths continue to UC-FO-011 on success.

**Acceptance criteria:** matches the prototype's pickup modal — accent-soft selected
rows with ink radio dots; Potvrdiť disabled while packeta address is blank; choosing
Iné reveals the note input; a re-submit opens with the previous choice selected;
the profile default updates only when the checkbox was ticked.

---

## UC-FO-011 Hotovo! success modal (Friend)

**Goal:** the post-submit modal with inline payment.

**Composition:** `NeoModal`, `closable`, `title="Hotovo!"`,
`subtitle="Objednávka bola odoslaná. Môžete ju upraviť až do uzamknutia cyklu."`
(both paths — resolved conflict #4). Footer: `button.btn` "OK".

**Body (top to bottom; payment block only when `hasPaymentSettings`):**

1. `.banner.ok.slim` with dot: `Suma na úhradu: <b class="mono">{{ paymentTotal.toFixed(2) }} EUR</b>`;
   when `order.delivery_fee` is set, a second line inside the banner in `.sub` 12px:
   `({{ cartTotal.toFixed(2) }} EUR + {{ order.delivery_fee.toFixed(2) }} EUR doručenie)`
   (repo information, kept — prototype silent).
2. Revolut button (only when `paymentRevolutUsername`): rendered as an `<a>` styled
   `btn block` with `background:#0075EB; color:#fff; border-color:#0a0a0a`, the Revolut
   glyph SVG (18×18, `fill:currentColor`, path from ui.jsx `RevolutBtn`), text
   **"Zaplatiť cez Revolut"**, `href="https://revolut.me/{username}"`,
   `target="_blank" rel="noopener noreferrer"` (shipped link behavior on prototype look).
3. QR block (only when `paymentIban`): centered — `.sub` "Pay by Square (QR kód pre
   bankovú appku)", the generated QR `<img>` inside `<div class="qr">` (02 UC-DS-012;
   img `display:block;width:100%;height:100%`), while generating a `.sub` "Generujem
   QR kód…", then `.sub.mono` 12px "IBAN: {{ paymentIban }}".

**Business rules:**

- QR generation stays exactly as shipped (`generateSuccessQr` — bysquare encode of
  `paymentTotal` with `paymentReference` as note; failures logged, block hidden).
- Opens from `doSubmitOrder()` success on both first submit and update; the snapshot
  (`lastSubmittedCart`) is taken before it opens (UC-FO-008).
- **Closing (OK, ×, scrim, Esc) navigates to the portal** — the shipped
  `handleSuccessModalClose` (`leaveConfirmed = true; router.push('/')`). Behavior is
  repo-canonical; the prototype merely closes. Kept.
- No payment reference copy row here — the reference lives ONLY in the Platba modal
  (README §Screens item 8 rule, applies to the friend side identically; module 06).

**Acceptance criteria:** modal matches the prototype's success state — ok-soft banner
with mono sum, blue Revolut bar, real scannable QR in the 190×190 ink frame, mono IBAN;
closing it lands on the portal without the leave-confirmation modal firing.

---

## UC-FO-012 Zrušiť objednávku confirm (Friend)

**Goal:** the destructive confirm before clearing the order.

**Composition:** `NeoModal`, `title="Zrušiť objednávku?"`,
`subtitle="Naozaj chcete zrušiť objednávku a vymazať všetky položky z košíka?"`.
Body: `.banner.danger.slim` with dot:
`Položky sa vymažú z košíka. Kolegov, ktorí objednali cez váš odkaz, sa to nedotkne.`
(prototype copy — new to production, in contract). Footer: `button.btn` "Nie" (close) +
`button.btn.danger` "Áno, zrušiť" → `confirmCancelOrder()`.

**Business rules (shipped semantics, unchanged):** confirm clears the cart; if an order
row exists it is deleted server-side (silent `saveCart` of the empty cart); the
snapshot resets; `leaveConfirmed` bypasses the guard; redirect to `/`. Admin dashboard
shows the friend as "Neobjednané". Opening is blocked when locked; the footer button is
disabled with an empty cart. Guests' sub-orders are untouched (the banner says exactly
that — it must stay true).

**Acceptance criteria:** danger-soft slim banner inside the modal; "Áno, zrušiť" clears
and lands on the portal; a colleague's sub-order visible on the Kolegovia tab before
the cancel is still present (and unpaid/undelivered flags intact) when the host returns.

---

## UC-FO-013 Leave-confirmation modal & navigation guard (Friend)

**Goal:** the shipped unsaved-changes guard, restyled. Not in the prototype (silent) —
behavior is repo-canonical and kept in full.

**Composition:** `NeoModal`, `title="Neuložené zmeny"`,
`subtitle="Máte neuložené zmeny v objednávke. Naozaj chcete opustiť stránku? Zmeny nebudú uložené."`
(repo copy, kept). Footer: `button.btn` "Zostať" (`cancelLeave`) + `button.btn.danger`
"Opustiť" (`confirmLeave`).

**Business rules (unchanged):** triggers via `goBack()` and `onBeforeRouteLeave` when
`hasUnsavedChanges` (submitted+dirty, or cart items with no order); `pendingNavigation`
resumes the intended route on confirm; `leaveConfirmed` one-shot bypass; cancel keeps
the user on the page with state intact.

**Acceptance criteria:** back-chevron with a dirty submitted order opens the modal;
Zostať keeps the cart; Opustiť navigates; the success and cancel flows (UC-FO-011/012)
never trigger it.

---

## UC-FO-014 Locked state — f-order-locked (Friend)

**Goal:** the read-only rendering when `isLocked` (`status ∈ {planned, locked,
completed}` — shipped definition, unchanged).

**Business rules (deltas from the open state; everything else renders identically):**

- Chrome: `chip` with lock icon instead of "Otvorené"; locked ticker copy (UC-FO-001).
- `.banner.warn` "Objednávky sú uzamknuté…" as the only status banner (UC-FO-002).
- Every `NeoStepper` gets `disabled` (`.stepper.disabled` — 0.35 opacity,
  pointer-events none, plus the `disabled` attribute); `setQuantity` guards stay as
  belt-and-braces.
- `.cartbar`: **no `.actions` row at all** (no Zrušiť/Zaplatiť/Aktualizovať — prototype;
  matches shipped `v-if="!isLocked"`), no warning banners; deadline, counts, sum and
  the cart `<details>` remain.
- Main switch fully functional; badge flips to amber pending semantics (UC-FO-003);
  the Kolegovia panel's locked content is module 05's.
- `OPEN:` the locked cartbar shows no Zaplatiť, so a friend who submitted but did not
  pay before the lock loses the payment shortcut on this screen (shipped behavior —
  the button is inside the `!isLocked` block; the prototype also hides all actions).
  Guests keep a Zaplatiť in their locked state (README item 9). Proposed default: keep
  as shipped/prototype (no button); flag for a product decision since it is a
  money-collection touchpoint.

**Acceptance criteria:** matches `07-shot.png` — lock chip, warn banner, locked ticker;
steppers visibly dimmed and inert; footer has no buttons; navigating away never
triggers the leave modal (nothing can be dirty).

---

## UC-FO-015 Verification — pinned selectors, suite, fidelity (Friend)

**Goal:** how the implementing tasks prove this module correct.

**Pinned DOM hooks (breaking any of these is a regression, not a restyle):**

| Hook | Where it must live after the restyle | Asserted by |
|---|---|---|
| `data-testid="purpose-tabs"` | the `.cat-tabs` strip | `mobile-no-h-overflow.spec.js` |
| `role="tab"` on each category tab | `.cat-tabs .tab` spans | same (counts `strip.getByRole('tab')`) |
| main switch = **first** `role="tablist"` in DOM, zero internal overflow at 320px | `.tabgroup` above `.cat-tabs` | same |
| `data-testid="main-tab-own"` / `"main-tab-guests"` with `aria-selected` | `.tabgroup .tab` spans | `guest-host-view.spec.js`, `guest-link.spec.js` |
| `data-testid="guest-tab-badge"` with the count as exact text | the `.tabbadge` | `guest-host-view.spec.js` |
| product name findable via `getByRole('heading', …)` | the card title — render it as an `<h3 class="display">` (a styled class, not a bare div, so the role survives) | `guest-host-view.spec.js` |
| `getByText('Celkom:')` visible on both tabs | `.cartbar .sum` | `guest-host-view.spec.js` |
| `getByText(CYCLE_NAME)` clickable on the portal → `/cycle/` | module 03's card (seam) | `mobile-no-h-overflow.spec.js` |

**Procedure:**

1. e2e suite at baseline **238 passed / 3 skipped** with zero spec edits — every
   behavior UC-FO-008…013 restates is already asserted somewhere in the suite.
2. Fidelity per 02 UC-DS-014 item 5: Playwright screenshots at 378px vs `03/07/08-shot.png`
   and 1180px vs `17-shot.png`, recorded in the PR. Interactive states (vbox `.sel`,
   dirty warning, details fold, modal stack) checked against the live prototype.
3. Admin invariance re-assertion (02 UC-DS-014 item 2).
4. This module is the regression net for `NeoStepper` and `snapTab` (02 UC-DS-014
   item 6) — at least one new/extended spec must exercise a stepper tap mutating the
   cart total and a cat-tab tap scrolling the strip horizontally only.

---

## Deliverables summary

| Path | Action |
|---|---|
| `frontend/src/views/FriendOrder.vue` | rewrite template + presentation bindings; script behavior preserved per UC-FO-008 |
| `frontend/src/lib/snap-tab.js`, `components/neo/*` | consumed, not modified (02) |
| `e2e/tests/*` | no edits to existing specs; additions per UC-FO-015 item 4 |

Modules NOT touched here: `GuestSubOrders.vue`, `GuestShareDialog.vue` (→ 05),
`PaymentModal.vue` (→ 06), portal files (→ 03).
