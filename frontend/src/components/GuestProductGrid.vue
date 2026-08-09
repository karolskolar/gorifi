<script setup>
import { computed, watch } from 'vue'
import NeoStepper from '@/components/neo/NeoStepper.vue'
import { snapTab } from '@/lib/snap-tab'
import { fmtEur } from '@/lib/money'
import {
  COFFEE_VARIANTS,
  VARIANT_GRAMS,
  cartGramsForProduct,
  cartKey,
  quantityIn
} from '@/lib/guest-cart'

// The guest product grid — purpose tabs, coffee cards with per-variant +/- boxes,
// bakery cards that group a product's variants into one card, and the per-product
// stock bar.
//
// ONE component, TWO screens (GSO-T4): the public ordering page `/g/:token` and
// the edit mode of the personal status page `/g/:token/o/:orderToken`. GSO-T3 had
// copied this grid out of FriendOrder.vue; the edit screen would have been a third
// copy, so it lives here now. Prices arrive from the server already marked up —
// this component never multiplies by markup_ratio.
//
// The cart is a two-way model rather than internal state: both screens need the
// priced lines and the total for their own footers, and the status screen also
// seeds the cart from the sub-order's persisted items.
//
// ============================ RD-GX-1 (06 §UC-GX-002) ============================
// The card markup below is LIFTED FROM `views/FriendOrder.vue` (RD-FO-2, 04
// §UC-FO-005/006/007), not re-derived: §UC-GX-002 deliberately does not respecify
// the card and requires it to be PIXEL-IDENTICAL to module 04's. Everything that
// differs is a guest-side fact, and there are exactly five:
//
//   1. `data-testid="product-{id}"` on the card root (04 uses `product-card`) —
//      the guest specs address cards by product id and are immutable.
//   2. `decTestid`/`valTestid`/`incTestid` on every stepper — `inc-{variant}` /
//      `dec-{variant}` / `qty-{variant}` for coffee, `…-unit-{id}` for bakery.
//      04 needs none of these; the guest specs pin all six.
//   3. NO `applyMarkup` around a price. Guest prices arrive already marked up
//      (GSO-T3, `backend/src/routes/guest.js withMarkup`), and multiplying here
//      would double it.
//   4. NO `:disabled` on the stepper. A guest grid is only ever rendered on an
//      orderable surface — a locked cycle 410s the listing on `/g/:token`, and the
//      status page publishes `products` only when `editable` (GSO-T4). There is no
//      "locked but visible" state for this grid to render.
//   5. This component owns its tab strip, so the strip and the card list are its
//      own root's children; 04 has them as siblings in the page column. The root is
//      therefore the same `flex column, gap 14` the page column would have given
//      them.
//
// ⚠ The whole-card selection ring is GONE (`getGroupQuantityTotal`, whose only
// consumer it was, with it). 04 §UC-FO-007 moved selection to the individual
// `.vbox`, so two variants of one bakery product now highlight independently —
// RD-FO-2 removed the friend-side copy for exactly this reason and the two cards
// have to agree.
//
// ⚠ Money renders through `lib/money.js`'s `fmtEur`, NOT `guest-cart.js`'s
// `formatPrice`. Identical output on every real price; `fmtEur` is fail-closed on
// non-finite input ("0.00 EUR" instead of "NaN EUR"/"Infinity EUR") — RD-DS-3 left
// the duplicate pointer for this row. `guest-cart.js` itself stays byte-unchanged
// (§UC-GX-002/011 forbid touching it); its `formatPrice` is retired when
// `GuestOrderStatus.vue`, its last consumer, is re-pointed in RD-GX-3.

const props = defineProps({
  products: { type: Array, default: () => [] },
  // productId → { stock_limit_g, ordered_g, remaining_g }. On the status screen
  // the server computes this with `excludeGuestOrderId`, so the grams this
  // sub-order already holds are NOT shown as taken.
  availability: { type: Object, default: () => ({}) },
  isBakery: { type: Boolean, default: false },
  emptyMessage: { type: String, default: 'V tomto cykle zatiaľ nie sú žiadne produkty.' }
})

const cart = defineModel({ type: Object, required: true })
// Still a two-way model: the ordering page keeps the selected purpose across a
// checkout round-trip. (The per-purpose page tint it also used to drive is gone —
// §UC-GX-001: the prototype background is uniform `--bg`.)
const activeTab = defineModel('activeTab', { type: String, default: '' })

function coffeeVariantsFor(product) {
  return COFFEE_VARIANTS.filter((v) => product[v.priceKey])
}

const groupedProducts = computed(() => {
  const groups = {}
  for (const product of props.products) {
    const purpose = product.purpose || 'Ostatné'
    if (!groups[purpose]) groups[purpose] = []
    groups[purpose].push(product)
  }
  return groups
})

// Bakery products are snapshotted one `products` row per variant; the card shows
// one product with a row per variant, grouped by source_bakery_product_id.
const groupedBakeryProducts = computed(() => {
  if (!props.isBakery) return groupedProducts.value

  const result = {}
  for (const [purpose, purposeProducts] of Object.entries(groupedProducts.value)) {
    const groups = []
    const seen = new Set()
    for (const product of purposeProducts) {
      const groupKey = product.source_bakery_product_id || product.id
      if (seen.has(groupKey)) continue
      seen.add(groupKey)

      const variants = purposeProducts.filter((p) =>
        p.source_bakery_product_id && p.source_bakery_product_id === product.source_bakery_product_id
      )
      groups.push(variants.length > 1 ? { ...variants[0], _variants: variants } : { ...product, _variants: [product] })
    }
    result[purpose] = groups
  }
  return result
})

const availablePurposes = computed(() => {
  const order = ['Espresso', 'Filter', 'Kapsule']
  const purposes = Object.keys(groupedProducts.value)
  const sorted = []
  for (const p of order) {
    if (purposes.includes(p)) sorted.push(p)
  }
  for (const p of purposes) {
    if (!order.includes(p)) sorted.push(p)
  }
  return sorted
})

// The cards of the ACTIVE purpose only — one list under the strip, which is what
// the radix `TabsContent` panels did. Same shape as FriendOrder's `activeProducts`.
const activeProducts = computed(() => {
  const source = props.isBakery ? groupedBakeryProducts.value : groupedProducts.value
  return source[activeTab.value] || []
})

watch(availablePurposes, (purposes) => {
  if (purposes.length > 0 && !purposes.includes(activeTab.value)) {
    activeTab.value = purposes[0]
  }
}, { immediate: true })

function getQuantity(productId, variant) {
  return quantityIn(cart.value, productId, variant)
}

// The server counts friend orders AND other guests' sub-orders; these two only
// keep the on-screen counter honest while the cart is being built.
function canIncrement(productId, variant) {
  const avail = props.availability[productId]
  if (!avail) return true
  return (avail.remaining_g - cartGramsForProduct(cart.value, productId) - (VARIANT_GRAMS[variant] || 0)) >= 0
}

function getRemainingGrams(productId) {
  const avail = props.availability[productId]
  if (!avail) return null
  return Math.max(0, avail.remaining_g - cartGramsForProduct(cart.value, productId))
}

// Grams → the prototype's kg copy, lifted from FriendOrder (04 §UC-FO-006,
// resolved conflict #6: repo gram MATH, kg DISPLAY). Up to 2 decimals, trailing
// zeros stripped, dot decimal.
function kg(grams) {
  return `${Math.round((grams || 0) / 10) / 100} kg`
}

// The bar's fill — derived from `getRemainingGrams`, i.e. it INCLUDES this cart's
// uncommitted grams, exactly as the shipped bar did, so emptying a variant walks
// the fill back live.
function stockPct(productId) {
  const avail = props.availability[productId]
  const limit = avail?.stock_limit_g
  if (!limit || limit <= 0) return 0
  return Math.min(100, ((limit - getRemainingGrams(productId)) / limit) * 100)
}

function setQuantity(productId, variant, quantity) {
  const key = cartKey(productId, variant)
  const next = { ...cart.value }
  if (quantity <= 0) delete next[key]
  else next[key] = quantity
  cart.value = next
}

function increment(productId, variant) {
  if (!canIncrement(productId, variant)) return
  setQuantity(productId, variant, getQuantity(productId, variant) + 1)
}

function decrement(productId, variant) {
  const current = getQuantity(productId, variant)
  if (current > 0) setQuantity(productId, variant, current - 1)
}

// The single bridge from `NeoStepper`'s absolute v-model to the cart mutators
// above. 02 §UC-DS-008 forbids a `max` in the primitive, so the stock ceiling
// lives HERE: routing an increase through `increment()` keeps `canIncrement()` in
// the path even when a click bypasses the disabled attribute. The stepper only
// ever emits ±1; a larger jump is clamped to one step rather than trusted.
function onQty(productId, variant, next) {
  const current = getQuantity(productId, variant)
  if (next > current) increment(productId, variant)
  else if (next < current) decrement(productId, variant)
}
</script>

<template>
  <!-- The strip and the card list are siblings inside a 14px-gap flex column —
       the geometry they would have had as direct children of the page column in
       04, reproduced here because this grid is a component and 04's is inline. -->
  <div class="flex flex-col gap-[14px]">
    <div v-if="products.length === 0" class="banner slim">
      <span class="dot"></span><span>{{ emptyMessage }}</span>
    </div>

    <template v-if="availablePurposes.length > 0">
      <!-- Category strip (04 §UC-FO-004 anatomy). Geometry comes from `.cat-tabs`
           in the theme and is NOT re-derived: `position:sticky; top:0; z-index:40`,
           hidden scrollbar, scroll-snap, the 28px right-edge fade. The tabs expose
           `role="tab"` and carry the house zero-pixel ARIA layer, because they are
           bare `<span>`s in the prototype and the radix triggers they replace were
           real buttons.

           Single purpose ⇒ no strip at all (shipped rule, unchanged); the cards
           below render either way. The per-purpose trigger tint map is DELETED
           (§UC-GX-002 item 1) — the neo tabs have exactly one selected style. -->
      <div
        v-if="availablePurposes.length > 1"
        class="cat-tabs"
        data-testid="purpose-tabs"
        role="tablist"
        aria-label="Kategórie produktov"
      >
        <span
          v-for="purpose in availablePurposes"
          :key="purpose"
          class="tab"
          :class="{ on: purpose === activeTab }"
          role="tab"
          tabindex="0"
          :aria-selected="purpose === activeTab ? 'true' : 'false'"
          @click="(e) => { snapTab(e); activeTab = purpose }"
          @keydown.enter.prevent="activeTab = purpose"
          @keydown.space.prevent="activeTab = purpose"
        >{{ purpose }}</span>
      </div>

      <!-- ⚠ ONE root per product, TWO bodies. `.card` IS the neo card (3px ink
           border, radius 14, `5px 5px 0` hard shadow); the shadcn `Card`/
           `CardContent` wrappers are gone, because leaving `.card` nested inside
           them would have drawn two borders and two shadows around every product.

           `phone` in 04's markup blocks is the prototype's DEMO FRAME TOGGLE; this
           port expresses it as Tailwind's `sm:` breakpoint, the idiom every friend
           surface already uses. The one thing a class cannot carry is
           `line-height`: `friends-theme.css` loads after Tailwind and
           `:where(.app,…) .display` has the same (0,1,0) specificity as
           `leading-[0.95]`, so every line-height below stays an INLINE style.

           Text metrics: every text-bearing element here carries a class already in
           the theme's A10 `line-height:normal` list (`.display`, `.badge`, `.sub`,
           `.mono`, `.vbox .vsize`, `.vbox .vprice`, `.stepper .val`), except the
           bakery header wrapper — see the note on it. A10 must NOT grow for this
           row. -->
      <div class="flex flex-col gap-4">
        <div
          v-for="product in activeProducts"
          :key="product.id"
          class="card p-[14px] sm:p-[18px]"
          :data-testid="`product-${product.id}`"
        >
          <!-- ==================== bakery (04 §UC-FO-007) ====================
               Branch condition unchanged from the shipped grid. One card per
               `source_bakery_product_id`; no image column (04's resolved conflict
               #8) and no stock bar — bakery products carry no availability row and
               `'unit'` is zero-gram by contract. -->
          <template v-if="isBakery && product.price_unit">
            <div class="flex justify-between gap-[10px] items-baseline">
              <!-- ⚠ `line-height:normal` at the CALL SITE. The `<h3>` below is
                   `inline` — deliberately, so it keeps the subtitle's baseline —
                   which makes THIS unclassed wrapper establish the line box, and
                   its strut comes from the wrapper's own inherited line-height.
                   Preflight's 1.5 makes every bakery card 4px too tall; A10 is a
                   class list and structurally cannot reach an unclassed element,
                   so it is fixed here exactly as 04 fixes it. The coffee card
                   needs nothing: its `<h3>` is block-level. -->
              <div class="min-w-0" style="overflow-wrap:anywhere;line-height:normal">
                <h3 class="display inline text-[19px] sm:text-[21px]" style="line-height:.95">{{ product.name }}</h3>
                <span v-if="product.description2" class="sub" style="font-size:13px;margin-left:8px">{{ product.description2 }}</span>
              </div>
              <!-- Card-level weight = the FIRST variant row's `weight_grams` (the
                   snapshot carries one per variant); the prototype shows exactly
                   one weight per card. -->
              <span
                v-if="product._variants[0].weight_grams"
                class="mono sub"
                style="font-size:12px;white-space:nowrap"
              >{{ product._variants[0].weight_grams }} g</span>
            </div>

            <div v-if="product.description1" class="sub" style="font-size:13px;margin-top:6px">{{ product.description1 }}</div>

            <details v-if="product.composition" style="margin-top:8px">
              <summary class="sub" style="cursor:pointer;font-size:13px">Zloženie</summary>
              <div class="sub" style="font-size:13px;margin-top:4px">{{ product.composition }}</div>
            </details>

            <!-- Column rule and the 368px floor: see the coffee grid below. -->
            <div
              class="grid gap-[10px] mt-3"
              :class="product._variants.length > 1 ? 'grid-cols-1 min-[368px]:grid-cols-2' : 'grid-cols-1'"
            >
              <div
                v-for="v in product._variants"
                :key="v.id"
                class="vbox"
                :class="{ sel: getQuantity(v.id, 'unit') > 0 }"
              >
                <div class="vrow">
                  <!-- NULL on legacy single-variant snapshots. -->
                  <span class="vsize">{{ v.variant_label || '1 ks' }}</span>
                  <span class="vprice">{{ fmtEur(v.price_unit) }}</span>
                </div>
                <NeoStepper
                  :model-value="getQuantity(v.id, 'unit')"
                  :inc-disabled="!canIncrement(v.id, 'unit')"
                  :dec-testid="`dec-unit-${v.id}`"
                  :val-testid="`qty-unit-${v.id}`"
                  :inc-testid="`inc-unit-${v.id}`"
                  @update:model-value="(q) => onQty(v.id, 'unit', q)"
                />
              </div>
            </div>
          </template>

          <!-- ==================== coffee (04 §UC-FO-005) ==================== -->
          <template v-else>
            <div class="flex gap-[13px] items-stretch">
              <!-- A product with no uploaded photo renders the BARE `.pimg` frame
                   — its built-in dark gradient and nothing else (02 §UC-DS-013's
                   disposition, closed by RD-FO-2). `min-height` = width,
                   `height:auto`, `align-self:stretch` is what makes the frame
                   track the text block's height. -->
              <div class="pimg w-[58px] sm:w-[70px] min-h-[58px] sm:min-h-[70px] h-auto self-stretch">
                <img
                  v-if="product.image"
                  :src="product.image"
                  alt=""
                  style="display:block;width:100%;height:100%;object-fit:cover"
                />
              </div>
              <!-- ⚠ `overflow-wrap:anywhere` is REQUIRED, not cosmetic, and
                   `min-w-0` alone does not do it: `min-w-0` lets the flex item
                   SHRINK, but an unbreakable token still paints outside it.
                   Product names are free admin text. Set on the CONTAINER because
                   `overflow-wrap` inherits and description1/2 are equally free. -->
              <div class="flex-1 min-w-0" style="overflow-wrap:anywhere">
                <h3 class="display text-[19px] sm:text-[21px]" style="line-height:.95">{{ product.name }}</h3>
                <div v-if="product.roast_type || product.roastery" class="flex flex-wrap gap-[6px] mt-2">
                  <span v-if="product.roast_type" class="badge" style="font-size:11px;padding:2px 7px">{{ product.roast_type }}</span>
                  <span v-if="product.roastery" class="badge acc-o" style="font-size:11px;padding:2px 7px">{{ product.roastery }}</span>
                </div>
                <!-- Fixed field mapping (04 §UC-FO-005): `description1` is the
                     spec line, `description2` the tasting notes. The old
                     `line-clamp-2` on the notes is dropped — the prototype does
                     not truncate them. -->
                <div v-if="product.description1" class="sub" style="margin-top:7px;font-size:13px">{{ product.description1 }}</div>
                <div v-if="product.description2" class="mono" style="font-size:12.5px;color:var(--ink-faint);margin-top:2px">{{ product.description2 }}</div>
              </div>
            </div>

            <!-- Stock-limit bar (04 §UC-FO-006). Renders between the description
                 row and the variant grid, only where the server returned an
                 availability row.

                 ⚠ The MATH is the shipped gram math, untouched: `remaining_g`
                 minus the grams already in THIS cart, counting friend orders AND
                 other guests' sub-orders server-side (`helpers/stock.js`). Only
                 the DISPLAY changed — grams became `kg()`, per prototype copy and
                 04's stock-bar spec, because §UC-GX-002 requires this card to be
                 pixel-identical to 04's and a gram label would not be. Fill is
                 always accent magenta; the sold-out signal is the danger-red
                 "Vypredané" LABEL, never a bar colour, so the old amber/red bar
                 tinting goes. -->
            <div v-if="availability[product.id]" class="flex items-center gap-[10px] mt-3" data-testid="stock-bar">
              <div style="flex:1;height:10px;border:2px solid var(--nb-ink);border-radius:6px;overflow:hidden;background:#fff">
                <div
                  data-testid="stock-fill"
                  :style="{ width: stockPct(product.id) + '%', height: '100%', background: 'var(--accent)' }"
                ></div>
              </div>
              <span
                v-if="getRemainingGrams(product.id) === 0"
                class="mono"
                data-testid="stock-label"
                style="font-size:11.5px;white-space:nowrap;color:var(--danger)"
              >Vypredané</span>
              <span
                v-else
                class="mono"
                data-testid="stock-label"
                style="font-size:11.5px;white-space:nowrap;color:var(--warn)"
              >Zostáva {{ kg(getRemainingGrams(product.id)) }} z {{ kg(availability[product.id].stock_limit_g) }}</span>
            </div>

            <!-- ⚠ COLUMN RULE and the 368px floor, lifted with its arithmetic.
                 `1fr` is written as `grid-cols-*` CLASSES, never an inline
                 `gridTemplateColumns`: `grid-cols-2` is `repeat(2, minmax(0,1fr))`
                 — minimum ZERO — so two columns at 320px overflow the document by
                 exactly 0, whereas the spec's literal `1fr 1fr` floors each track
                 at the item's min-content and scrolls the page sideways.

                 The media query's job is the opposite one: stopping a track from
                 sitting BELOW a `.vbox`'s 146px min-content, where the shortfall
                 is absorbed by the 38×38 stepper buttons shrinking. Two boxes plus
                 the 10px gap need 302px of card CONTENT box, and that box is
                 `viewport − 32 (page column) − 28 (card padding) − 6 (.card's own
                 3px border a side)`; 302 + 66 = 368.

                 ⚠ 368, not 362: dropping the border term puts the switch 6px low
                 and 362–367 renders the "+" at 36.5–37.75px. -->
            <div
              class="grid gap-[10px] mt-[13px]"
              :class="coffeeVariantsFor(product).length > 1 ? 'grid-cols-1 min-[368px]:grid-cols-2' : 'grid-cols-1'"
            >
              <div
                v-for="def in coffeeVariantsFor(product)"
                :key="def.variant"
                class="vbox"
                :class="{ sel: getQuantity(product.id, def.variant) > 0 }"
              >
                <div class="vrow">
                  <span class="vsize">{{ def.label }}</span>
                  <span class="vprice">{{ fmtEur(product[def.priceKey]) }}</span>
                </div>
                <!-- ⚠ THE `+` CEILING, and why BOTH halves are here. 02 §UC-DS-008
                     forbids a `max` in `NeoStepper`, so the rule lives in the
                     consumer; §UC-GX-002 says the increment is SILENTLY refused.
                     `incDisabled` carries the shipped semantics — the pre-redesign
                     "+" was a real `:disabled` button at the ceiling, and dropping
                     that would take the state away from assistive tech, the one
                     audience a silent refusal cannot reach. And it is NOT the
                     enforcement: `onQty` routes every increase through
                     `increment()`, which re-checks `canIncrement()`, so a
                     programmatic click that bypasses the attribute still cannot
                     exceed the limit. The server remains the authority either way
                     (GSO-T3 `helpers/stock.js`). -->
                <NeoStepper
                  :model-value="getQuantity(product.id, def.variant)"
                  :inc-disabled="!canIncrement(product.id, def.variant)"
                  :dec-testid="`dec-${def.variant}`"
                  :val-testid="`qty-${def.variant}`"
                  :inc-testid="`inc-${def.variant}`"
                  @update:model-value="(q) => onQty(product.id, def.variant, q)"
                />
              </div>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
