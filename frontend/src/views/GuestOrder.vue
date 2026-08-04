<script setup>
import { ref, computed, onMounted, watch, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import api from '../api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import PaymentModal from '@/components/PaymentModal.vue'

// Public guest ordering page — route `/g/:token` (§UC-GSO-001..003).
//
// Same product-card layout as FriendOrder.vue (incl. bakery variant grouping),
// stripped of everything that needs an account: no login, no delivery/pickup
// modal, no drafts, no auto-save. Checkout is name + mobile (+ optional email)
// and one submit; the sub-order is created only by that submit.
//
// Prices arrive from the server with the cycle markup already applied, so this
// page never multiplies by markup_ratio itself — what the guest sees is exactly
// what gets frozen onto guest_order_items.price.

const route = useRoute()
const token = computed(() => route.params.token)

const GUEST_STORAGE_KEY = 'gorifi_guest_orders'

const loading = ref(true)
const unavailable = ref(null) // { status, reason, message } when the link is dead
const cycle = ref(null)
const host = ref(null)
const products = ref([])
const availability = ref({})

const cart = ref({}) // { `${productId}-${variant}`: quantity }
const activeTab = ref('')

const showCheckout = ref(false)
const submitting = ref(false)
const checkoutError = ref('')
const guestName = ref('')
const guestPhone = ref('')
const guestEmail = ref('')

// Confirmation state (§UC-GSO-003)
const confirmation = ref(null) // { order, items, payment, status_url }
const showPaymentModal = ref(false)

const variantGrams = { '150g': 150, '200g': 200, '250g': 250, '500g': 500, '1kg': 1000, '20pc5g': 100 }

// Coffee weight variants, in display order. Data-driven so the five near-identical
// price boxes of FriendOrder.vue stay one template block here.
const COFFEE_VARIANTS = [
  { variant: '150g', label: '150g', priceKey: 'price_150g' },
  { variant: '200g', label: '200g', priceKey: 'price_200g' },
  { variant: '250g', label: '250g', priceKey: 'price_250g' },
  { variant: '500g', label: '500g', priceKey: 'price_500g' },
  { variant: '1kg', label: '1kg', priceKey: 'price_1kg' },
  { variant: '20pc5g', label: '20 ks × 5g', priceKey: 'price_20pc5g' }
]

const isBakery = computed(() => cycle.value?.type === 'bakery')

function coffeeVariantsFor(product) {
  return COFFEE_VARIANTS.filter((v) => product[v.priceKey])
}

const groupedProducts = computed(() => {
  const groups = {}
  for (const product of products.value) {
    const purpose = product.purpose || 'Ostatné'
    if (!groups[purpose]) groups[purpose] = []
    groups[purpose].push(product)
  }
  return groups
})

// Bakery products are snapshotted one products row per variant; the card shows
// one product with a row per variant, grouped by source_bakery_product_id.
const groupedBakeryProducts = computed(() => {
  if (!isBakery.value) return groupedProducts.value

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

const displayedProducts = computed(() => (isBakery.value ? groupedBakeryProducts.value : groupedProducts.value))

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

function priceFor(product, variant) {
  if (variant === 'unit') return product.price_unit
  const def = COFFEE_VARIANTS.find((v) => v.variant === variant)
  return def ? product[def.priceKey] : null
}

const cartItems = computed(() => {
  const items = []
  for (const [key, quantity] of Object.entries(cart.value)) {
    if (quantity <= 0) continue
    const separator = key.lastIndexOf('-')
    const productId = parseInt(key.slice(0, separator), 10)
    const variant = key.slice(separator + 1)
    const product = products.value.find((p) => p.id === productId)
    if (!product) continue
    const price = priceFor(product, variant)
    if (!price) continue
    items.push({
      key,
      product_id: productId,
      product_name: product.name,
      variant_label: product.variant_label || null,
      variant,
      quantity,
      price,
      total: price * quantity
    })
  }
  return items
})

const cartTotal = computed(() =>
  Math.round(cartItems.value.reduce((sum, item) => sum + item.total, 0) * 100) / 100
)

function getCartKey(productId, variant) {
  return `${productId}-${variant}`
}

function getQuantity(productId, variant) {
  return cart.value[getCartKey(productId, variant)] || 0
}

function getGroupQuantityTotal(variants) {
  return variants.reduce((sum, v) => sum + getQuantity(v.id, 'unit'), 0)
}

// Grams of a product already in this guest's cart.
function getCartGramsForProduct(productId) {
  let grams = 0
  for (const [key, quantity] of Object.entries(cart.value)) {
    if (quantity <= 0) continue
    const separator = key.lastIndexOf('-')
    if (parseInt(key.slice(0, separator), 10) !== productId) continue
    grams += (variantGrams[key.slice(separator + 1)] || 0) * quantity
  }
  return grams
}

// The server counts friend orders AND other guests' sub-orders; this only keeps
// the counter honest while the cart is being built.
function canIncrement(productId, variant) {
  const avail = availability.value[productId]
  if (!avail) return true
  return (avail.remaining_g - getCartGramsForProduct(productId) - (variantGrams[variant] || 0)) >= 0
}

function getRemainingGrams(productId) {
  const avail = availability.value[productId]
  if (!avail) return null
  return Math.max(0, avail.remaining_g - getCartGramsForProduct(productId))
}

function setQuantity(productId, variant, quantity) {
  const key = getCartKey(productId, variant)
  if (quantity <= 0) delete cart.value[key]
  else cart.value[key] = quantity
  cart.value = { ...cart.value }
}

function increment(productId, variant) {
  if (!canIncrement(productId, variant)) return
  setQuantity(productId, variant, getQuantity(productId, variant) + 1)
}

function decrement(productId, variant) {
  const current = getQuantity(productId, variant)
  if (current > 0) setQuantity(productId, variant, current - 1)
}

function formatPrice(price) {
  return `${Number(price || 0).toFixed(2)} EUR`
}

function variantText(item) {
  if (item.variant_label) return item.variant_label
  if (item.variant === 'unit') return 'ks'
  if (item.variant === '20pc5g') return '20 ks × 5g'
  return item.variant
}

const backgroundClass = computed(() => {
  if (isBakery.value) {
    if (activeTab.value === 'Slané') return 'bg-amber-50'
    if (activeTab.value === 'Sladké') return 'bg-pink-50'
    return 'bg-background'
  }
  if (activeTab.value === 'Espresso') return 'bg-stone-200'
  if (activeTab.value === 'Filter') return 'bg-sky-100'
  if (activeTab.value === 'Kapsule') return 'bg-amber-100'
  return 'bg-background'
})

function getTabTriggerClass(purpose) {
  if (activeTab.value !== purpose) return ''
  if (purpose === 'Slané') return 'bg-amber-600 text-white data-[state=active]:bg-amber-600 data-[state=active]:text-white'
  if (purpose === 'Sladké') return 'bg-pink-600 text-white data-[state=active]:bg-pink-600 data-[state=active]:text-white'
  if (purpose === 'Espresso') return 'bg-stone-600 text-white data-[state=active]:bg-stone-600 data-[state=active]:text-white'
  if (purpose === 'Filter') return 'bg-sky-600 text-white data-[state=active]:bg-sky-600 data-[state=active]:text-white'
  if (purpose === 'Kapsule') return 'bg-amber-600 text-white data-[state=active]:bg-amber-600 data-[state=active]:text-white'
  return ''
}

watchEffect(() => {
  document.title = cycle.value?.name ? `${cycle.value.name} - Objednávka` : 'Objednávka'
})

onMounted(load)

async function load() {
  loading.value = true
  unavailable.value = null
  try {
    const data = await api.getGuestOrderPage(token.value)
    cycle.value = data.cycle
    host.value = data.host
    products.value = data.products || []
    const map = {}
    for (const entry of data.availability || []) {
      map[entry.product_id] = entry
    }
    availability.value = map
  } catch (e) {
    // 404 = no such link, 410 = deactivated or cycle closed. Both dead ends, but
    // they need different wording.
    unavailable.value = {
      status: e.status || 0,
      reason: e.reason || null,
      message: e.message
    }
  } finally {
    loading.value = false
  }
}

const unavailableTitle = computed(() => {
  if (!unavailable.value) return ''
  if (unavailable.value.status === 404) return 'Odkaz neexistuje'
  if (unavailable.value.reason === 'inactive') return 'Odkaz už nie je aktívny'
  if (unavailable.value.reason === 'closed') return 'Objednávanie je uzavreté'
  return 'Objednávka nie je dostupná'
})

function openCheckout() {
  checkoutError.value = ''
  showCheckout.value = true
}

// Decision 7: name + mobile required (>= 9 digits), email optional. The server
// validates the same rule — this is only so the guest finds out immediately.
function validateIdentity() {
  if (!guestName.value.trim()) return 'Zadajte svoje meno.'
  const digits = guestPhone.value.replace(/\D/g, '')
  if (digits.length < 9) return 'Zadajte telefónne číslo (aspoň 9 číslic).'
  return ''
}

async function submitOrder() {
  const problem = validateIdentity()
  if (problem) {
    checkoutError.value = problem
    return
  }
  if (cartItems.value.length === 0) {
    checkoutError.value = 'Košík je prázdny.'
    return
  }

  submitting.value = true
  checkoutError.value = ''
  try {
    const payload = {
      guest_name: guestName.value.trim(),
      guest_phone: guestPhone.value.trim(),
      items: cartItems.value.map((item) => ({
        product_id: item.product_id,
        variant: item.variant,
        quantity: item.quantity
      }))
    }
    const email = guestEmail.value.trim()
    if (email) payload.guest_email = email

    const result = await api.submitGuestOrder(token.value, payload)
    const statusUrl = `${window.location.origin}${result.status_path}`
    confirmation.value = { ...result, status_url: statusUrl }
    rememberStatusUrl(result, statusUrl)

    showCheckout.value = false
    // §UC-GSO-003: the confirmation opens the payment modal straight away.
    if (result.payment?.iban || result.payment?.revolut_username) {
      showPaymentModal.value = true
    }
  } catch (e) {
    // 409 = the cycle was locked while the guest was shopping; 400 = validation
    // or a stock limit (details lists the products).
    checkoutError.value = [e.message, ...(e.details || [])].join(' ')
  } finally {
    submitting.value = false
  }
}

// Keep the personal status URL on the device so the guest can come back to it
// (the page itself is served by GSO-T4). Stored per link token, newest wins.
function rememberStatusUrl(result, statusUrl) {
  try {
    const raw = localStorage.getItem(GUEST_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    const store = parsed && typeof parsed === 'object' ? parsed : {}
    store[token.value] = {
      order_id: result.order.id,
      order_token: result.order.order_token,
      status_url: statusUrl,
      guest_name: result.order.guest_name,
      cycle_name: cycle.value?.name || '',
      total: result.order.total,
      saved_at: new Date().toISOString()
    }
    localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(store))
  } catch (e) {
    // Private mode / full storage: the URL is still on screen, so this is
    // convenience only and must never break the confirmation.
  }
}

// Which button most recently copied: 'reference' | 'status-url' | ''. A single
// ref rather than passing a ref in from the template — template refs are
// unwrapped, so a `flag.value = true` on the argument would throw on a plain
// boolean and the "Skopírované" label would never appear.
const copiedTarget = ref('')

async function copyText(text, target) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch (e) {
    // Fallback for browsers without the async clipboard API (mirrors
    // GuestShareDialog.copyLink) — a guest on an old mobile browser still needs
    // the status URL.
    try {
      const input = document.createElement('input')
      input.value = text
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
    } catch (fallbackError) {
      return // Nothing worked; the value stays selectable on screen.
    }
  }
  copiedTarget.value = target
  setTimeout(() => {
    if (copiedTarget.value === target) copiedTarget.value = ''
  }, 2000)
}
</script>

<template>
  <div :class="['min-h-screen transition-colors', backgroundClass]">
    <div v-if="loading" class="max-w-4xl mx-auto px-4 py-16 text-center text-muted-foreground">
      Načítavam…
    </div>

    <!-- Dead link: deactivated, unknown, or a cycle that is no longer open -->
    <div v-else-if="unavailable" class="max-w-md mx-auto px-4 py-16">
      <Card data-testid="guest-unavailable">
        <CardContent class="p-6 text-center space-y-3">
          <div class="text-4xl">🔒</div>
          <h1 class="text-xl font-semibold">{{ unavailableTitle }}</h1>
          <p class="text-sm text-muted-foreground">{{ unavailable.message }}</p>
          <p class="text-sm text-muted-foreground">
            Ak ste odkaz dostali od kolegu, požiadajte ho o nový.
          </p>
        </CardContent>
      </Card>
    </div>

    <!-- Confirmation (§UC-GSO-003) -->
    <div v-else-if="confirmation" class="max-w-md mx-auto px-4 py-8">
      <Card data-testid="guest-confirmation">
        <CardContent class="p-6 space-y-4">
          <div class="text-center space-y-1">
            <div class="text-4xl">✅</div>
            <h1 class="text-xl font-semibold">Objednávka je odoslaná</h1>
            <p class="text-sm text-muted-foreground">
              {{ cycle?.name }} · organizuje {{ host?.first_name }}
            </p>
          </div>

          <div class="rounded-lg border p-3 space-y-1 text-sm">
            <div class="flex justify-between">
              <span class="text-muted-foreground">Suma na úhradu</span>
              <span class="font-semibold">{{ formatPrice(confirmation.payment.amount) }}</span>
            </div>
            <div v-for="item in confirmation.items" :key="item.id" class="flex justify-between text-xs text-muted-foreground">
              <span>{{ item.product_name }} ({{ variantText(item) }}) x{{ item.quantity }}</span>
              <span>{{ formatPrice(item.price * item.quantity) }}</span>
            </div>
          </div>

          <!-- Payment reference. Revolut cannot pre-fill a note, so the guest has
               to paste it there themselves. -->
          <div class="space-y-1">
            <Label class="text-xs text-muted-foreground">Poznámka k platbe (uveďte ju pri platbe)</Label>
            <div class="flex gap-2">
              <div
                data-testid="payment-reference"
                class="flex-1 rounded-md border bg-muted/40 px-3 py-2 text-sm font-mono break-all"
              >{{ confirmation.payment.reference }}</div>
              <Button variant="outline" size="sm" data-testid="copy-reference" @click="copyText(confirmation.payment.reference, 'reference')">
                {{ copiedTarget === 'reference' ? 'Skopírované' : 'Kopírovať' }}
              </Button>
            </div>
          </div>

          <Button
            v-if="confirmation.payment.iban || confirmation.payment.revolut_username"
            class="w-full"
            @click="showPaymentModal = true"
          >
            Zaplatiť
          </Button>

          <!-- Personal status URL (page served by GSO-T4) -->
          <div class="space-y-1">
            <Label class="text-xs text-muted-foreground">Odkaz na vašu objednávku — uložte si ho</Label>
            <div class="flex gap-2">
              <Input :model-value="confirmation.status_url" readonly data-testid="guest-status-url" class="text-xs" />
              <Button variant="outline" size="sm" data-testid="copy-status-url" @click="copyText(confirmation.status_url, 'status-url')">
                {{ copiedTarget === 'status-url' ? 'Skopírované' : 'Kopírovať' }}
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">
              Na tomto odkaze uvidíte stav objednávky. Odkaz je uložený aj v tomto prehliadači.
            </p>
          </div>

          <p class="text-xs text-muted-foreground text-center">
            Tovar vám odovzdá {{ host?.first_name }}.
          </p>
        </CardContent>
      </Card>
    </div>

    <!-- Ordering (§UC-GSO-001/002) -->
    <div v-else class="max-w-4xl mx-auto px-4 py-4">
      <Card class="mb-4">
        <CardContent class="p-4">
          <h1 class="text-lg font-semibold">{{ cycle?.name }}</h1>
          <p class="text-sm text-muted-foreground">
            Spoločná objednávka · organizuje {{ host?.first_name }}
          </p>
          <p v-if="cycle?.expected_date" class="text-xs text-primary mt-1">
            📅 Objednávka do: <span class="font-medium">{{ cycle.expected_date }}</span>
          </p>
          <p v-if="cycle?.plan_note" class="text-xs text-muted-foreground mt-1">{{ cycle.plan_note }}</p>
          <p class="text-xs text-muted-foreground mt-2">
            Účet netreba. Vyberte si tovar, na konci zadajte meno a telefón.
          </p>
        </CardContent>
      </Card>

      <Alert v-if="products.length === 0" class="mb-4">
        <AlertDescription>V tomto cykle zatiaľ nie sú žiadne produkty.</AlertDescription>
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
                          <span class="w-6 text-center font-semibold text-sm">{{ getQuantity(v.id, 'unit') }}</span>
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
                          :style="{ width: Math.min(100, ((availability[product.id].stock_limit_g - availability[product.id].remaining_g + getCartGramsForProduct(product.id)) / availability[product.id].stock_limit_g) * 100) + '%' }"
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
                        <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, def.variant) }}</span>
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

      <!-- Sticky cart footer -->
      <div class="fixed bottom-0 left-0 right-0 bg-card shadow-lg border-t z-50">
        <div class="max-w-4xl mx-auto px-4 py-2">
          <div class="flex justify-between items-center gap-2 mb-1.5">
            <div class="flex items-center gap-1.5">
              <span class="text-xs text-muted-foreground">Položiek: {{ cartItems.length }}</span>
              <span class="mx-1 text-xs">|</span>
              <span class="font-semibold text-sm" data-testid="cart-total">Celkom: {{ formatPrice(cartTotal) }}</span>
            </div>
            <Button size="sm" class="h-8 text-xs" data-testid="open-checkout" :disabled="cartItems.length === 0" @click="openCheckout">
              Objednať
            </Button>
          </div>

          <details v-if="cartItems.length > 0" class="mt-1">
            <summary class="text-sm text-muted-foreground cursor-pointer">Zobraziť položky v košíku</summary>
            <div class="mt-2 text-sm max-h-48 overflow-y-auto">
              <div v-for="item in cartItems" :key="item.key" class="flex justify-between py-1 border-b border-border">
                <span>{{ item.product_name }} ({{ variantText(item) }}) x{{ item.quantity }}</span>
                <span>{{ formatPrice(item.total) }}</span>
              </div>
            </div>
          </details>
        </div>
      </div>
      <div class="h-32"></div>
    </div>

    <!-- Checkout: name + mobile required, email optional -->
    <Dialog :open="showCheckout" @update:open="val => showCheckout = val">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Dokončiť objednávku</DialogTitle>
          <DialogDescription>
            Suma na úhradu: <strong>{{ formatPrice(cartTotal) }}</strong>. Platba prevodom, tovar vám odovzdá {{ host?.first_name }}.
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-3">
          <div class="space-y-1">
            <Label for="guest-name">Meno *</Label>
            <Input id="guest-name" v-model="guestName" data-testid="guest-name" placeholder="Meno a priezvisko" maxlength="120" />
          </div>
          <div class="space-y-1">
            <Label for="guest-phone">Mobil *</Label>
            <Input id="guest-phone" v-model="guestPhone" data-testid="guest-phone" placeholder="0901 234 567" inputmode="tel" maxlength="32" />
          </div>
          <div class="space-y-1">
            <Label for="guest-email">E-mail (nepovinné)</Label>
            <Input id="guest-email" v-model="guestEmail" data-testid="guest-email" placeholder="meno@example.com" inputmode="email" maxlength="160" />
          </div>

          <Alert v-if="checkoutError" variant="destructive">
            <AlertDescription data-testid="checkout-error">{{ checkoutError }}</AlertDescription>
          </Alert>
        </div>

        <DialogFooter class="flex gap-2">
          <Button variant="outline" class="flex-1" @click="showCheckout = false">Späť</Button>
          <Button class="flex-1" data-testid="guest-submit" :disabled="submitting" @click="submitOrder">
            {{ submitting ? 'Odosielam…' : 'Odoslať objednávku' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Same payment modal friends use: Revolut link + Pay by Square QR -->
    <PaymentModal
      v-if="confirmation"
      :open="showPaymentModal"
      :amount="confirmation.payment.amount"
      :reference="confirmation.payment.reference"
      :iban="confirmation.payment.iban"
      :revolut-username="confirmation.payment.revolut_username"
      @close="showPaymentModal = false"
    />
  </div>
</template>
