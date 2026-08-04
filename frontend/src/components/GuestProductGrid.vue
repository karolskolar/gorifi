<script setup>
import { computed, watch } from 'vue'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  COFFEE_VARIANTS,
  VARIANT_GRAMS,
  cartGramsForProduct,
  cartKey,
  formatPrice,
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
// Exposed because the page tints its background from the selected purpose.
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

const displayedProducts = computed(() => (props.isBakery ? groupedBakeryProducts.value : groupedProducts.value))

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

watch(availablePurposes, (purposes) => {
  if (purposes.length > 0 && !purposes.includes(activeTab.value)) {
    activeTab.value = purposes[0]
  }
}, { immediate: true })

function getQuantity(productId, variant) {
  return quantityIn(cart.value, productId, variant)
}

function getGroupQuantityTotal(variants) {
  return variants.reduce((sum, v) => sum + getQuantity(v.id, 'unit'), 0)
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

// Tab tint, per purpose. Kept here with the tabs it colours.
function getTabTriggerClass(purpose) {
  if (activeTab.value !== purpose) return ''
  if (purpose === 'Slané') return 'bg-amber-600 text-white data-[state=active]:bg-amber-600 data-[state=active]:text-white'
  if (purpose === 'Sladké') return 'bg-pink-600 text-white data-[state=active]:bg-pink-600 data-[state=active]:text-white'
  if (purpose === 'Espresso') return 'bg-stone-600 text-white data-[state=active]:bg-stone-600 data-[state=active]:text-white'
  if (purpose === 'Filter') return 'bg-sky-600 text-white data-[state=active]:bg-sky-600 data-[state=active]:text-white'
  if (purpose === 'Kapsule') return 'bg-amber-600 text-white data-[state=active]:bg-amber-600 data-[state=active]:text-white'
  return ''
}
</script>

<template>
  <div>
    <Alert v-if="products.length === 0" class="mb-4">
      <AlertDescription>{{ emptyMessage }}</AlertDescription>
    </Alert>

    <!-- One block for every cycle shape: the tab bar only appears when there is
         more than one purpose to switch between. -->
    <Tabs v-if="availablePurposes.length > 0" v-model="activeTab" class="w-full">
      <TabsList v-if="availablePurposes.length > 1" class="w-full justify-start bg-card/95 backdrop-blur">
        <TabsTrigger
          v-for="purpose in availablePurposes"
          :key="purpose"
          :value="purpose"
          :class="['flex-1', getTabTriggerClass(purpose)]"
        >
          {{ purpose }}
        </TabsTrigger>
      </TabsList>
      <TabsContent v-for="purpose in availablePurposes" :key="purpose" :value="purpose" class="mt-4">
        <div class="space-y-3">
          <Card v-for="product in displayedProducts[purpose]" :key="product.id" :data-testid="`product-${product.id}`">
            <CardContent class="p-0">
              <!-- Bakery card: one card per product, one row per variant -->
              <div v-if="isBakery && product.price_unit" :class="['flex rounded-lg overflow-hidden', getGroupQuantityTotal(product._variants) > 0 ? 'ring-2 ring-primary' : '']">
                <div class="w-28 flex-shrink-0 bg-muted flex items-center justify-center">
                  <img v-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                </div>
                <div class="flex-1 min-w-0 p-3 flex flex-col">
                  <div class="flex items-baseline gap-2">
                    <h3 class="font-semibold text-foreground">{{ product.name }}</h3>
                    <span v-if="product.description2" class="text-sm text-muted-foreground">{{ product.description2 }}</span>
                  </div>
                  <p v-if="product.description1" class="text-sm text-muted-foreground mt-0.5">{{ product.description1 }}</p>
                  <details v-if="product.composition" class="mt-1">
                    <summary class="text-xs text-muted-foreground/70 cursor-pointer select-none">Zloženie</summary>
                    <p class="text-xs text-muted-foreground/70 mt-0.5">{{ product.composition }}</p>
                  </details>
                  <div class="mt-auto pt-2 space-y-1.5">
                    <div v-for="v in product._variants" :key="v.id" class="flex items-center justify-between">
                      <div class="text-sm">
                        <span class="font-semibold text-primary">{{ formatPrice(v.price_unit) }}</span>
                        <span v-if="v.variant_label" class="text-muted-foreground ml-1">/ {{ v.variant_label }}</span>
                      </div>
                      <div class="flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="icon"
                          class="h-8 w-8 rounded-full"
                          :data-testid="`dec-unit-${v.id}`"
                          :disabled="getQuantity(v.id, 'unit') === 0"
                          @click="decrement(v.id, 'unit')"
                        >-</Button>
                        <span class="w-6 text-center font-semibold text-sm" :data-testid="`qty-unit-${v.id}`">{{ getQuantity(v.id, 'unit') }}</span>
                        <Button
                          variant="outline"
                          size="icon"
                          class="h-8 w-8 rounded-full"
                          :data-testid="`inc-unit-${v.id}`"
                          @click="increment(v.id, 'unit')"
                        >+</Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Coffee card -->
              <div v-else class="p-4">
                <div class="flex gap-4 mb-3">
                  <div class="w-20 h-20 flex-shrink-0 bg-muted rounded-lg overflow-hidden flex items-center justify-center">
                    <img v-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <h3 class="font-semibold text-foreground">{{ product.name }}</h3>
                      <span v-if="product.roast_type" class="text-xs text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded-full whitespace-nowrap">{{ product.roast_type }}</span>
                      <span v-if="product.roastery" class="text-xs bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">{{ product.roastery }}</span>
                    </div>
                    <p v-if="product.description1" class="text-sm text-muted-foreground">{{ product.description1 }}</p>
                    <p v-if="product.description2" class="text-sm text-muted-foreground/70 mt-1 line-clamp-2">{{ product.description2 }}</p>
                  </div>
                </div>

                <!-- Stock limit indicator (counts friend + other guests' items) -->
                <div v-if="availability[product.id]" class="mb-2">
                  <div class="flex items-center gap-2 text-xs">
                    <div class="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                      <div
                        class="h-full rounded-full transition-all"
                        :class="getRemainingGrams(product.id) === 0 ? 'bg-destructive' : getRemainingGrams(product.id) < availability[product.id].stock_limit_g * 0.25 ? 'bg-amber-500' : 'bg-primary'"
                        :style="{ width: Math.min(100, ((availability[product.id].stock_limit_g - availability[product.id].remaining_g + cartGramsForProduct(cart, product.id)) / availability[product.id].stock_limit_g) * 100) + '%' }"
                      />
                    </div>
                    <span v-if="getRemainingGrams(product.id) === 0" class="text-destructive font-medium whitespace-nowrap">Vypredané</span>
                    <span v-else class="text-muted-foreground whitespace-nowrap">Zostáva: {{ getRemainingGrams(product.id) }}g z {{ availability[product.id].stock_limit_g }}g</span>
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div
                    v-for="def in coffeeVariantsFor(product)"
                    :key="def.variant"
                    :class="[
                      'rounded-lg p-2 transition-colors',
                      getQuantity(product.id, def.variant) > 0 ? 'bg-primary/10 border-2 border-primary' : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-1">
                      <span class="text-sm font-medium">{{ def.label }}</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(product[def.priceKey]) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        class="h-8 w-8 rounded-full"
                        :data-testid="`dec-${def.variant}`"
                        :disabled="getQuantity(product.id, def.variant) === 0"
                        @click="decrement(product.id, def.variant)"
                      >-</Button>
                      <span class="w-8 text-center font-semibold" :data-testid="`qty-${def.variant}`">{{ getQuantity(product.id, def.variant) }}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        class="h-8 w-8 rounded-full"
                        :data-testid="`inc-${def.variant}`"
                        :disabled="!canIncrement(product.id, def.variant)"
                        @click="increment(product.id, def.variant)"
                      >+</Button>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </TabsContent>
    </Tabs>
  </div>
</template>
