<script setup>
import { ref, computed, onMounted, watchEffect, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api, { getFriendsPassword } from '../api'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

const route = useRoute()
const router = useRouter()

// Cycle/friend data
const friend = ref(null)
const cycle = ref(null)
const products = ref([])
const order = ref(null)
const cart = ref({}) // { productId-variant: quantity }
const lastSubmittedCart = ref(null) // Snapshot of cart at last submission

// UI state
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const successMessage = ref('')
const activeTab = ref('Espresso')
const showSuccessModal = ref(false)
const successModalMessage = ref('')
const showCancelModal = ref(false)
const initialLoadComplete = ref(false) // Prevents auto-save during initial load

const cycleId = computed(() => route.params.cycleId)

const isLocked = computed(() => cycle.value?.status === 'locked' || cycle.value?.status === 'completed')
const isSubmitted = computed(() => order.value?.status === 'submitted')
const markupRatio = computed(() => cycle.value?.markup_ratio || 1.0)

// Check if there are unsubmitted changes after an order was submitted
const hasUnsubmittedChanges = computed(() => {
  if (!isSubmitted.value || !lastSubmittedCart.value) return false
  // Compare current cart with last submitted cart
  const currentKeys = Object.keys(cart.value).filter(k => cart.value[k] > 0)
  const lastKeys = Object.keys(lastSubmittedCart.value).filter(k => lastSubmittedCart.value[k] > 0)
  if (currentKeys.length !== lastKeys.length) return true
  for (const key of currentKeys) {
    if (cart.value[key] !== lastSubmittedCart.value[key]) return true
  }
  return false
})

const cartItems = computed(() => {
  const items = []
  const ratio = markupRatio.value
  for (const [key, quantity] of Object.entries(cart.value)) {
    if (quantity > 0) {
      const [productId, variant] = key.split('-')
      const product = products.value.find(p => p.id === parseInt(productId))
      if (product) {
        let basePrice
        if (variant === '1kg') basePrice = product.price_1kg
        else if (variant === '20pc5g') basePrice = product.price_20pc5g
        else if (variant === '150g') basePrice = product.price_150g
        else if (variant === '200g') basePrice = product.price_200g
        else basePrice = product.price_250g
        // Apply markup ratio to get final price
        const price = Math.round(basePrice * ratio * 100) / 100
        items.push({
          key,
          product_id: parseInt(productId),
          product_name: product.name,
          purpose: product.purpose || 'Ostatné',
          variant,
          quantity,
          price,
          total: price * quantity
        })
      }
    }
  }
  return items
})

const groupedCartItems = computed(() => {
  const groups = {}
  for (const item of cartItems.value) {
    const purpose = item.purpose
    if (!groups[purpose]) groups[purpose] = []
    groups[purpose].push(item)
  }
  // Sort by purpose order: Espresso, Filter, Kapsule, then others
  const order = ['Espresso', 'Filter', 'Kapsule']
  const sortedGroups = {}
  for (const p of order) {
    if (groups[p]) sortedGroups[p] = groups[p]
  }
  for (const p of Object.keys(groups)) {
    if (!order.includes(p)) sortedGroups[p] = groups[p]
  }
  return sortedGroups
})

const cartTotal = computed(() => {
  return cartItems.value.reduce((sum, item) => sum + item.total, 0)
})

const groupedProducts = computed(() => {
  const groups = {}
  for (const product of products.value) {
    const type = product.purpose || 'Ostatne'
    if (!groups[type]) groups[type] = []
    groups[type].push(product)
  }
  return groups
})

const availablePurposes = computed(() => {
  // Order: Espresso, Filter, Kapsule, then others
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

const backgroundClass = computed(() => {
  if (activeTab.value === 'Espresso') return 'bg-stone-200'
  if (activeTab.value === 'Filter') return 'bg-sky-100'
  if (activeTab.value === 'Kapsule') return 'bg-amber-100'
  return 'bg-background'
})

function getTabTriggerClass(purpose) {
  const isActive = activeTab.value === purpose
  if (!isActive) return ''
  if (purpose === 'Espresso') return 'bg-stone-600 text-white data-[state=active]:bg-stone-600 data-[state=active]:text-white'
  if (purpose === 'Filter') return 'bg-sky-600 text-white data-[state=active]:bg-sky-600 data-[state=active]:text-white'
  if (purpose === 'Kapsule') return 'bg-amber-600 text-white data-[state=active]:bg-amber-600 data-[state=active]:text-white'
  return ''
}

// Set active tab to first available purpose when products load
watch(availablePurposes, (purposes) => {
  if (purposes.length > 0 && !purposes.includes(activeTab.value)) {
    activeTab.value = purposes[0]
  }
}, { immediate: true })

const STORAGE_KEY = 'gorifi_friend_auth'

onMounted(async () => {
  // Check if authenticated
  if (!getFriendsPassword()) {
    // Try to restore from localStorage
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) {
      router.push('/')
      return
    }
    try {
      const parsed = JSON.parse(stored)
      if (!parsed.password) {
        router.push('/')
        return
      }
      // Password will be set by FriendPortal, redirect there
      router.push('/')
      return
    } catch {
      router.push('/')
      return
    }
  }

  await loadOrderData()
})

// Set page title
watchEffect(() => {
  document.title = cycle.value?.name ? `${cycle.value.name} - Objednávka` : 'Objednávka'
})

async function loadOrderData() {
  loading.value = true
  error.value = ''

  try {
    // Get friend info from localStorage
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) {
      router.push('/')
      return
    }

    const parsed = JSON.parse(stored)
    const friendId = parsed.friendId

    // Get order data
    const orderData = await api.getOrderByFriend(cycleId.value, friendId)
    order.value = orderData.order
    cycle.value = orderData.cycle
    friend.value = orderData.friend

    // Get products
    products.value = await api.getProducts(cycleId.value)

    // Populate cart from existing order items
    cart.value = {}
    for (const item of orderData.items) {
      cart.value[`${item.product_id}-${item.variant}`] = item.quantity
    }

    // If order is already submitted, store snapshot for change detection
    if (orderData.order?.status === 'submitted') {
      lastSubmittedCart.value = { ...cart.value }
    } else {
      lastSubmittedCart.value = null
    }

    // Mark initial load as complete after a short delay
    // This prevents auto-save from triggering during initial data population
    setTimeout(() => {
      initialLoadComplete.value = true
    }, 100)
  } catch (e) {
    error.value = e.message
    // If auth error, redirect to portal
    if (e.message.includes('heslo') || e.message.includes('Heslo')) {
      setTimeout(() => router.push('/'), 2000)
    }
  } finally {
    loading.value = false
  }
}

function goBack() {
  router.push('/')
}

function getCartKey(productId, variant) {
  return `${productId}-${variant}`
}

function getQuantity(productId, variant) {
  return cart.value[getCartKey(productId, variant)] || 0
}

function setQuantity(productId, variant, quantity) {
  if (isLocked.value) return
  const key = getCartKey(productId, variant)
  if (quantity <= 0) {
    delete cart.value[key]
  } else {
    cart.value[key] = quantity
  }
  cart.value = { ...cart.value } // trigger reactivity
}

function increment(productId, variant) {
  if (isLocked.value) return
  const current = getQuantity(productId, variant)
  setQuantity(productId, variant, current + 1)
}

function decrement(productId, variant) {
  if (isLocked.value) return
  const current = getQuantity(productId, variant)
  if (current > 0) {
    setQuantity(productId, variant, current - 1)
  }
}

// Auto-save debounce timer
let autoSaveTimeout = null
const autoSaving = ref(false)

async function saveCart(silent = false) {
  if (isLocked.value) return
  if (!friend.value) return

  if (!silent) saving.value = true
  else autoSaving.value = true

  error.value = ''
  if (!silent) successMessage.value = ''

  try {
    const items = cartItems.value.map(item => ({
      product_id: item.product_id,
      variant: item.variant,
      quantity: item.quantity
    }))

    const result = await api.updateOrderByFriend(cycleId.value, friend.value.id, items)
    order.value = result.order

    if (!silent) {
      successMessage.value = 'Košík bol uložený'
      setTimeout(() => {
        successMessage.value = ''
      }, 3000)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    if (!silent) saving.value = false
    else autoSaving.value = false
  }
}

// Auto-save cart when it changes (debounced)
watch(cart, () => {
  // Skip auto-save during initial load or when locked
  if (!initialLoadComplete.value || isLocked.value || !friend.value) return

  // Clear previous timeout
  if (autoSaveTimeout) clearTimeout(autoSaveTimeout)

  // Debounce: save after 500ms of no changes
  autoSaveTimeout = setTimeout(() => {
    saveCart(true)
  }, 500)
}, { deep: true })

function cancelOrder() {
  if (isLocked.value) return
  showCancelModal.value = true
}

async function confirmCancelOrder() {
  showCancelModal.value = false

  // Clear the cart
  cart.value = {}

  // Save empty cart to server
  await saveCart(true)
}

async function submitOrder() {
  if (isLocked.value) return
  if (cartItems.value.length === 0) {
    error.value = 'Košík je prázdny'
    return
  }

  // Capture state before submitting
  const wasAlreadySubmitted = isSubmitted.value

  // First save the cart
  await saveCart()

  saving.value = true
  error.value = ''

  try {
    const result = await api.submitOrderByFriend(cycleId.value, friend.value.id)
    order.value = result.order
    // Store snapshot of submitted cart for change detection
    lastSubmittedCart.value = { ...cart.value }
    successModalMessage.value = wasAlreadySubmitted
      ? 'Vaša objednávka bola aktualizovaná!'
      : 'Vaša objednávka bola úspešne odoslaná!'
    showSuccessModal.value = true
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

function handleSuccessModalClose() {
  showSuccessModal.value = false
  router.push('/')
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}

function applyMarkup(price) {
  if (!price) return null
  return Math.round(price * markupRatio.value * 100) / 100
}
</script>

<template>
  <div :class="['min-h-screen transition-colors', backgroundClass]">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow sticky top-0 z-40 relative">
      <div class="max-w-4xl mx-auto px-4 py-3 flex justify-between items-center">
        <div class="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            @click="goBack"
            class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </Button>
          <div v-if="friend" class="flex flex-col">
            <span class="text-lg font-semibold">{{ friend.name }}</span>
            <span class="text-primary-foreground/70 text-sm">{{ cycle?.name }}</span>
          </div>
        </div>
      </div>
    </header>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12 text-muted-foreground">Načítavam...</div>

    <!-- Error -->
    <div v-else-if="error && !friend" class="max-w-4xl mx-auto px-4 py-12">
      <Alert variant="destructive">
        <AlertDescription>
          <strong>Chyba:</strong> {{ error }}
        </AlertDescription>
      </Alert>
      <Button @click="goBack" class="mt-4">Späť na zoznam cyklov</Button>
    </div>

    <!-- Order Form -->
    <div v-else class="max-w-4xl mx-auto px-4 py-6">
      <!-- Status banner -->
      <Alert v-if="isLocked" class="mb-6 border-yellow-500 bg-yellow-50 text-yellow-800">
        <AlertDescription>
          <strong>Objednávky sú uzamknuté.</strong> Už nie je možné meniť objednávku.
        </AlertDescription>
      </Alert>

      <Alert v-if="isSubmitted && !isLocked" class="mb-6 border-green-500 bg-green-50 text-green-800">
        <AlertDescription>
          <strong>Vaša objednávka bola odoslaná!</strong> Stále ju môžete upraviť až do uzamknutia.
        </AlertDescription>
      </Alert>

      <!-- Messages -->
      <Alert v-if="error" variant="destructive" class="mb-4">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>
      <Alert v-if="successMessage" class="mb-4 border-green-500 bg-green-50 text-green-800">
        <AlertDescription>{{ successMessage }}</AlertDescription>
      </Alert>

      <!-- Products by purpose with tabs -->
      <Tabs v-if="availablePurposes.length > 1" v-model="activeTab" :default-value="availablePurposes[0]" class="w-full">
        <TabsList class="sticky top-16 z-30 w-full justify-start bg-card/95 backdrop-blur">
          <TabsTrigger
            v-for="purpose in availablePurposes"
            :key="purpose"
            :value="purpose"
            :class="['flex-1', getTabTriggerClass(purpose)]"
          >
            {{ purpose }}
          </TabsTrigger>
        </TabsList>

        <TabsContent
          v-for="purpose in availablePurposes"
          :key="purpose"
          :value="purpose"
          class="mt-4"
        >
          <div class="space-y-3">
            <Card
              v-for="product in groupedProducts[purpose]"
              :key="product.id"
            >
              <CardContent class="p-4">
                <div class="flex gap-4 mb-3">
                  <!-- Product image -->
                  <div class="w-20 h-20 flex-shrink-0 bg-muted rounded-lg overflow-hidden flex items-center justify-center">
                    <img v-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                    <svg v-else class="w-8 h-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <!-- Product info -->
                  <div class="flex-1 min-w-0">
                    <h3 class="font-semibold text-foreground">{{ product.name }}</h3>
                    <p v-if="product.description1" class="text-sm text-muted-foreground">{{ product.description1 }}</p>
                    <p v-if="product.description2" class="text-sm text-muted-foreground/70 mt-1 line-clamp-2">{{ product.description2 }}</p>
                  </div>
                </div>

                <!-- Capsule variant (20 ks × 5g) -->
                <div v-if="product.price_20pc5g" class="grid grid-cols-1 gap-4">
                  <div
                    :class="[
                      'rounded-lg p-3 transition-colors',
                      getQuantity(product.id, '20pc5g') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-2">
                      <span class="text-sm font-medium">20 ks × 5g</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_20pc5g)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-3">
                      <Button
                        variant="outline"
                        size="icon"
                        @click="decrement(product.id, '20pc5g')"
                        :disabled="isLocked || getQuantity(product.id, '20pc5g') === 0"
                        class="h-8 w-8 rounded-full"
                      >
                        -
                      </Button>
                      <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '20pc5g') }}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        @click="increment(product.id, '20pc5g')"
                        :disabled="isLocked"
                        class="h-8 w-8 rounded-full"
                      >
                        +
                      </Button>
                    </div>
                  </div>
                </div>

                <!-- Weight variants (150g / 200g / 250g / 1kg) -->
                <div v-else class="grid grid-cols-2 gap-4">
                  <!-- 150g variant -->
                  <div
                    v-if="product.price_150g"
                    :class="[
                      'rounded-lg p-3 transition-colors',
                      getQuantity(product.id, '150g') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-2">
                      <span class="text-sm font-medium">150g</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_150g)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-3">
                      <Button
                        variant="outline"
                        size="icon"
                        @click="decrement(product.id, '150g')"
                        :disabled="isLocked || getQuantity(product.id, '150g') === 0"
                        class="h-8 w-8 rounded-full"
                      >
                        -
                      </Button>
                      <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '150g') }}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        @click="increment(product.id, '150g')"
                        :disabled="isLocked"
                        class="h-8 w-8 rounded-full"
                      >
                        +
                      </Button>
                    </div>
                  </div>

                  <!-- 200g variant -->
                  <div
                    v-if="product.price_200g"
                    :class="[
                      'rounded-lg p-3 transition-colors',
                      getQuantity(product.id, '200g') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-2">
                      <span class="text-sm font-medium">200g</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_200g)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-3">
                      <Button
                        variant="outline"
                        size="icon"
                        @click="decrement(product.id, '200g')"
                        :disabled="isLocked || getQuantity(product.id, '200g') === 0"
                        class="h-8 w-8 rounded-full"
                      >
                        -
                      </Button>
                      <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '200g') }}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        @click="increment(product.id, '200g')"
                        :disabled="isLocked"
                        class="h-8 w-8 rounded-full"
                      >
                        +
                      </Button>
                    </div>
                  </div>

                  <!-- 250g variant -->
                  <div
                    v-if="product.price_250g"
                    :class="[
                      'rounded-lg p-3 transition-colors',
                      getQuantity(product.id, '250g') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-2">
                      <span class="text-sm font-medium">250g</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_250g)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-3">
                      <Button
                        variant="outline"
                        size="icon"
                        @click="decrement(product.id, '250g')"
                        :disabled="isLocked || getQuantity(product.id, '250g') === 0"
                        class="h-8 w-8 rounded-full"
                      >
                        -
                      </Button>
                      <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '250g') }}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        @click="increment(product.id, '250g')"
                        :disabled="isLocked"
                        class="h-8 w-8 rounded-full"
                      >
                        +
                      </Button>
                    </div>
                  </div>

                  <!-- 1kg variant -->
                  <div
                    v-if="product.price_1kg"
                    :class="[
                      'rounded-lg p-3 transition-colors',
                      getQuantity(product.id, '1kg') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-2">
                      <span class="text-sm font-medium">1kg</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_1kg)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-3">
                      <Button
                        variant="outline"
                        size="icon"
                        @click="decrement(product.id, '1kg')"
                        :disabled="isLocked || getQuantity(product.id, '1kg') === 0"
                        class="h-8 w-8 rounded-full"
                      >
                        -
                      </Button>
                      <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '1kg') }}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        @click="increment(product.id, '1kg')"
                        :disabled="isLocked"
                        class="h-8 w-8 rounded-full"
                      >
                        +
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <!-- Fallback: show all products without tabs when only one purpose -->
      <div v-else-if="availablePurposes.length === 1" class="space-y-3">
        <Card
          v-for="product in groupedProducts[availablePurposes[0]]"
          :key="product.id"
        >
          <CardContent class="p-4">
            <div class="flex gap-4 mb-3">
              <div class="w-20 h-20 flex-shrink-0 bg-muted rounded-lg overflow-hidden flex items-center justify-center">
                <img v-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                <svg v-else class="w-8 h-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <h3 class="font-semibold text-foreground">{{ product.name }}</h3>
                <p v-if="product.description1" class="text-sm text-muted-foreground">{{ product.description1 }}</p>
                <p v-if="product.description2" class="text-sm text-muted-foreground/70 mt-1 line-clamp-2">{{ product.description2 }}</p>
              </div>
            </div>

            <!-- Capsule variant (20 ks × 5g) -->
            <div v-if="product.price_20pc5g" class="grid grid-cols-1 gap-4">
              <div
                :class="[
                  'rounded-lg p-3 transition-colors',
                  getQuantity(product.id, '20pc5g') > 0
                    ? 'bg-primary/10 border-2 border-primary'
                    : 'border bg-card'
                ]"
              >
                <div class="flex justify-between items-center mb-2">
                  <span class="text-sm font-medium">20 ks × 5g</span>
                  <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_20pc5g)) }}</span>
                </div>
                <div class="flex items-center justify-center gap-3">
                  <Button
                    variant="outline"
                    size="icon"
                    @click="decrement(product.id, '20pc5g')"
                    :disabled="isLocked || getQuantity(product.id, '20pc5g') === 0"
                    class="h-8 w-8 rounded-full"
                  >
                    -
                  </Button>
                  <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '20pc5g') }}</span>
                  <Button
                    variant="outline"
                    size="icon"
                    @click="increment(product.id, '20pc5g')"
                    :disabled="isLocked"
                    class="h-8 w-8 rounded-full"
                  >
                    +
                  </Button>
                </div>
              </div>
            </div>

            <!-- Weight variants (150g / 200g / 250g / 1kg) -->
            <div v-else class="grid grid-cols-2 gap-4">
              <div
                v-if="product.price_150g"
                :class="[
                  'rounded-lg p-3 transition-colors',
                  getQuantity(product.id, '150g') > 0
                    ? 'bg-primary/10 border-2 border-primary'
                    : 'border bg-card'
                ]"
              >
                <div class="flex justify-between items-center mb-2">
                  <span class="text-sm font-medium">150g</span>
                  <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_150g)) }}</span>
                </div>
                <div class="flex items-center justify-center gap-3">
                  <Button
                    variant="outline"
                    size="icon"
                    @click="decrement(product.id, '150g')"
                    :disabled="isLocked || getQuantity(product.id, '150g') === 0"
                    class="h-8 w-8 rounded-full"
                  >
                    -
                  </Button>
                  <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '150g') }}</span>
                  <Button
                    variant="outline"
                    size="icon"
                    @click="increment(product.id, '150g')"
                    :disabled="isLocked"
                    class="h-8 w-8 rounded-full"
                  >
                    +
                  </Button>
                </div>
              </div>

              <div
                v-if="product.price_200g"
                :class="[
                  'rounded-lg p-3 transition-colors',
                  getQuantity(product.id, '200g') > 0
                    ? 'bg-primary/10 border-2 border-primary'
                    : 'border bg-card'
                ]"
              >
                <div class="flex justify-between items-center mb-2">
                  <span class="text-sm font-medium">200g</span>
                  <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_200g)) }}</span>
                </div>
                <div class="flex items-center justify-center gap-3">
                  <Button
                    variant="outline"
                    size="icon"
                    @click="decrement(product.id, '200g')"
                    :disabled="isLocked || getQuantity(product.id, '200g') === 0"
                    class="h-8 w-8 rounded-full"
                  >
                    -
                  </Button>
                  <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '200g') }}</span>
                  <Button
                    variant="outline"
                    size="icon"
                    @click="increment(product.id, '200g')"
                    :disabled="isLocked"
                    class="h-8 w-8 rounded-full"
                  >
                    +
                  </Button>
                </div>
              </div>

              <div
                v-if="product.price_250g"
                :class="[
                  'rounded-lg p-3 transition-colors',
                  getQuantity(product.id, '250g') > 0
                    ? 'bg-primary/10 border-2 border-primary'
                    : 'border bg-card'
                ]"
              >
                <div class="flex justify-between items-center mb-2">
                  <span class="text-sm font-medium">250g</span>
                  <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_250g)) }}</span>
                </div>
                <div class="flex items-center justify-center gap-3">
                  <Button
                    variant="outline"
                    size="icon"
                    @click="decrement(product.id, '250g')"
                    :disabled="isLocked || getQuantity(product.id, '250g') === 0"
                    class="h-8 w-8 rounded-full"
                  >
                    -
                  </Button>
                  <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '250g') }}</span>
                  <Button
                    variant="outline"
                    size="icon"
                    @click="increment(product.id, '250g')"
                    :disabled="isLocked"
                    class="h-8 w-8 rounded-full"
                  >
                    +
                  </Button>
                </div>
              </div>

              <div
                v-if="product.price_1kg"
                :class="[
                  'rounded-lg p-3 transition-colors',
                  getQuantity(product.id, '1kg') > 0
                    ? 'bg-primary/10 border-2 border-primary'
                    : 'border bg-card'
                ]"
              >
                <div class="flex justify-between items-center mb-2">
                  <span class="text-sm font-medium">1kg</span>
                  <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_1kg)) }}</span>
                </div>
                <div class="flex items-center justify-center gap-3">
                  <Button
                    variant="outline"
                    size="icon"
                    @click="decrement(product.id, '1kg')"
                    :disabled="isLocked || getQuantity(product.id, '1kg') === 0"
                    class="h-8 w-8 rounded-full"
                  >
                    -
                  </Button>
                  <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '1kg') }}</span>
                  <Button
                    variant="outline"
                    size="icon"
                    @click="increment(product.id, '1kg')"
                    :disabled="isLocked"
                    class="h-8 w-8 rounded-full"
                  >
                    +
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- Sticky cart footer -->
      <div class="fixed bottom-0 left-0 right-0 bg-card shadow-lg border-t z-50">
        <div class="max-w-4xl mx-auto px-4 py-4">
          <div v-if="cycle?.expected_date" class="text-sm text-primary mb-2">
            📅 Objednávka do: <span class="font-medium">{{ cycle.expected_date }}</span>
          </div>

          <!-- Order status notifications -->
          <div v-if="!isLocked && cartItems.length > 0 && !isSubmitted" class="mb-3 px-3 py-2 bg-yellow-50 border border-yellow-300 rounded-lg text-yellow-800 text-sm flex items-center gap-2">
            <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span><strong>Objednávka ešte nebola odoslaná.</strong> Stlačte tlačidlo "Odoslať objednávku".</span>
          </div>

          <div v-else-if="!isLocked && hasUnsubmittedChanges" class="mb-3 px-3 py-2 bg-orange-50 border border-orange-300 rounded-lg text-orange-800 text-sm flex items-center gap-2">
            <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span><strong>Zmeny v objednávke neboli odoslané.</strong> Stlačte tlačidlo "Aktualizovať objednávku".</span>
          </div>

          <div class="flex justify-between items-center mb-3">
            <div class="flex items-center gap-2">
              <span class="text-muted-foreground">Položiek: {{ cartItems.length }}</span>
              <span class="mx-2">|</span>
              <span class="font-semibold text-lg">Celkom: {{ formatPrice(cartTotal) }}</span>
              <span v-if="autoSaving" class="text-xs text-muted-foreground animate-pulse">Ukladám...</span>
            </div>
          </div>

          <div v-if="!isLocked" class="flex gap-3">
            <Button
              variant="outline"
              @click="cancelOrder"
              :disabled="saving || cartItems.length === 0"
              class="flex-1 border-red-500 text-red-600 hover:bg-red-50 hover:text-red-700"
            >
              Zrušiť objednávku
            </Button>
            <Button
              @click="submitOrder"
              :disabled="saving || cartItems.length === 0"
              class="flex-1"
            >
              {{ saving ? 'Odosielám...' : (isSubmitted ? 'Aktualizovať objednávku' : 'Odoslať objednávku') }}
            </Button>
          </div>

          <!-- Cart details toggle -->
          <details class="mt-3">
            <summary class="text-sm text-muted-foreground cursor-pointer">Zobraziť položky v košíku</summary>
            <div class="mt-2 text-sm max-h-48 overflow-y-auto">
              <div v-if="cartItems.length === 0" class="text-muted-foreground py-2 text-center">
                Košík je prázdny
              </div>
              <template v-else v-for="(items, purpose) in groupedCartItems" :key="purpose">
                <div
                  class="text-xs font-semibold px-2 py-1 mt-2 first:mt-0 rounded"
                  :class="{
                    'bg-stone-200 text-stone-700': purpose === 'Espresso',
                    'bg-sky-100 text-sky-700': purpose === 'Filter',
                    'bg-amber-100 text-amber-700': purpose === 'Kapsule',
                    'bg-muted text-muted-foreground': !['Espresso', 'Filter', 'Kapsule'].includes(purpose)
                  }"
                >
                  {{ purpose }}
                </div>
                <div v-for="item in items" :key="item.key" class="flex justify-between py-1 border-b border-border">
                  <span>{{ item.product_name }} ({{ item.variant }}) x{{ item.quantity }}</span>
                  <span>{{ formatPrice(item.total) }}</span>
                </div>
              </template>
            </div>
          </details>
        </div>
      </div>

      <!-- Spacer for fixed footer -->
      <div class="h-40"></div>
    </div>

    <!-- Success Modal -->
    <Dialog :open="showSuccessModal" @update:open="val => !val && handleSuccessModalClose()">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Hotovo!
          </DialogTitle>
          <DialogDescription class="text-base">
            {{ successModalMessage }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button @click="handleSuccessModalClose" class="w-full">
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Cancel Order Confirmation Modal -->
    <Dialog :open="showCancelModal" @update:open="showCancelModal = $event">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <svg class="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Zrušiť objednávku?
          </DialogTitle>
          <DialogDescription class="text-base">
            Naozaj chcete zrušiť objednávku a vymazať všetky položky z košíka?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter class="flex gap-2">
          <Button variant="outline" @click="showCancelModal = false" class="flex-1">
            Nie
          </Button>
          <Button @click="confirmCancelOrder" class="flex-1 bg-red-600 hover:bg-red-700">
            Áno, zrušiť
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
