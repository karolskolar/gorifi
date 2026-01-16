<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '../api'

const route = useRoute()

const friend = ref(null)
const cycle = ref(null)
const products = ref([])
const order = ref(null)
const cart = ref({}) // { productId-variant: quantity }

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const successMessage = ref('')

const token = computed(() => route.params.token)

const isLocked = computed(() => cycle.value?.status === 'locked' || cycle.value?.status === 'completed')
const isSubmitted = computed(() => order.value?.status === 'submitted')

const cartItems = computed(() => {
  const items = []
  for (const [key, quantity] of Object.entries(cart.value)) {
    if (quantity > 0) {
      const [productId, variant] = key.split('-')
      const product = products.value.find(p => p.id === parseInt(productId))
      if (product) {
        const price = variant === '1kg' ? product.price_1kg : product.price_250g
        items.push({
          key,
          product_id: parseInt(productId),
          product_name: product.name,
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

onMounted(async () => {
  await loadData()
})

async function loadData() {
  loading.value = true
  try {
    // Get friend info
    friend.value = await api.getFriendByToken(token.value)

    // Get products
    products.value = await api.getProducts(friend.value.cycle_id)

    // Get existing order
    const orderData = await api.getOrderByToken(token.value)
    order.value = orderData.order
    cycle.value = orderData.cycle

    // Populate cart from existing order items
    cart.value = {}
    for (const item of orderData.items) {
      cart.value[`${item.product_id}-${item.variant}`] = item.quantity
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
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

async function saveCart() {
  if (isLocked.value) return

  saving.value = true
  error.value = ''
  successMessage.value = ''

  try {
    const items = cartItems.value.map(item => ({
      product_id: item.product_id,
      variant: item.variant,
      quantity: item.quantity
    }))

    const result = await api.updateOrder(token.value, items)
    order.value = result.order
    successMessage.value = 'Kosik bol ulozeny'

    setTimeout(() => {
      successMessage.value = ''
    }, 3000)
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

async function submitOrder() {
  if (isLocked.value) return
  if (cartItems.value.length === 0) {
    error.value = 'Kosik je prazdny'
    return
  }

  // First save the cart
  await saveCart()

  saving.value = true
  error.value = ''

  try {
    const result = await api.submitOrder(token.value)
    order.value = result.order
    successMessage.value = 'Objednavka bola odoslana!'
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

function formatPrice(price) {
  return price ? `${price.toFixed(2)} EUR` : '-'
}
</script>

<template>
  <div class="min-h-screen bg-amber-50">
    <!-- Header -->
    <header class="bg-amber-800 text-white shadow sticky top-0 z-40">
      <div class="max-w-4xl mx-auto px-4 py-4">
        <h1 class="text-xl font-bold">Gorifi - Objednavka kavy</h1>
        <p v-if="friend" class="text-amber-200 text-sm">{{ friend.name }} | {{ cycle?.name }}</p>
      </div>
    </header>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12 text-gray-500">Nacitavam...</div>

    <!-- Error -->
    <div v-else-if="error && !friend" class="max-w-4xl mx-auto px-4 py-12">
      <div class="bg-red-50 text-red-700 p-6 rounded-lg text-center">
        <h2 class="text-lg font-semibold mb-2">Chyba</h2>
        <p>{{ error }}</p>
      </div>
    </div>

    <!-- Main content -->
    <div v-else class="max-w-4xl mx-auto px-4 py-6">
      <!-- Status banner -->
      <div v-if="isLocked" class="mb-6 p-4 bg-yellow-100 text-yellow-800 rounded-lg text-center">
        <strong>Objednavky su uzamknute.</strong> Uz nie je mozne menit objednavku.
      </div>

      <div v-if="isSubmitted && !isLocked" class="mb-6 p-4 bg-green-100 text-green-800 rounded-lg text-center">
        <strong>Vasa objednavka bola odoslana!</strong> Stale ju mozete upravit az do uzamknutia.
      </div>

      <!-- Messages -->
      <div v-if="error" class="mb-4 p-4 bg-red-50 text-red-700 rounded-lg">{{ error }}</div>
      <div v-if="successMessage" class="mb-4 p-4 bg-green-50 text-green-700 rounded-lg">{{ successMessage }}</div>

      <!-- Products by roast type -->
      <div v-for="(groupProducts, roastType) in groupedProducts" :key="roastType" class="mb-8">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 sticky top-16 bg-amber-50 py-2 z-30">
          {{ roastType }}
        </h2>

        <div class="space-y-3">
          <div
            v-for="product in groupProducts"
            :key="product.id"
            class="bg-white rounded-lg shadow p-4"
          >
            <div class="flex gap-4 mb-3">
              <!-- Product image -->
              <div class="w-20 h-20 flex-shrink-0 bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center">
                <img v-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                <svg v-else class="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <!-- Product info -->
              <div class="flex-1 min-w-0">
                <h3 class="font-semibold text-gray-800">{{ product.name }}</h3>
                <p v-if="product.description1" class="text-sm text-gray-600">{{ product.description1 }}</p>
                <p v-if="product.description2" class="text-sm text-gray-500 mt-1 line-clamp-2">{{ product.description2 }}</p>
                <p v-if="product.purpose" class="text-xs text-amber-700 mt-1">{{ product.purpose }}</p>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <!-- 250g variant -->
              <div v-if="product.price_250g" class="border rounded-lg p-3">
                <div class="flex justify-between items-center mb-2">
                  <span class="text-sm font-medium">250g</span>
                  <span class="text-sm text-amber-700 font-semibold">{{ formatPrice(product.price_250g) }}</span>
                </div>
                <div class="flex items-center justify-center gap-3">
                  <button
                    @click="decrement(product.id, '250g')"
                    :disabled="isLocked || getQuantity(product.id, '250g') === 0"
                    class="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    -
                  </button>
                  <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '250g') }}</span>
                  <button
                    @click="increment(product.id, '250g')"
                    :disabled="isLocked"
                    class="w-8 h-8 rounded-full bg-amber-100 text-amber-700 hover:bg-amber-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    +
                  </button>
                </div>
              </div>

              <!-- 1kg variant -->
              <div v-if="product.price_1kg" class="border rounded-lg p-3">
                <div class="flex justify-between items-center mb-2">
                  <span class="text-sm font-medium">1kg</span>
                  <span class="text-sm text-amber-700 font-semibold">{{ formatPrice(product.price_1kg) }}</span>
                </div>
                <div class="flex items-center justify-center gap-3">
                  <button
                    @click="decrement(product.id, '1kg')"
                    :disabled="isLocked || getQuantity(product.id, '1kg') === 0"
                    class="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    -
                  </button>
                  <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '1kg') }}</span>
                  <button
                    @click="increment(product.id, '1kg')"
                    :disabled="isLocked"
                    class="w-8 h-8 rounded-full bg-amber-100 text-amber-700 hover:bg-amber-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Sticky cart footer -->
      <div v-if="cartItems.length > 0" class="fixed bottom-0 left-0 right-0 bg-white shadow-lg border-t z-50">
        <div class="max-w-4xl mx-auto px-4 py-4">
          <div class="flex justify-between items-center mb-3">
            <div>
              <span class="text-gray-600">Poloziek: {{ cartItems.length }}</span>
              <span class="mx-2">|</span>
              <span class="font-semibold text-lg">Celkom: {{ formatPrice(cartTotal) }}</span>
            </div>
          </div>

          <div v-if="!isLocked" class="flex gap-3">
            <button
              @click="saveCart"
              :disabled="saving"
              class="flex-1 px-4 py-3 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 disabled:opacity-50"
            >
              {{ saving ? 'Ukladam...' : 'Ulozit kosik' }}
            </button>
            <button
              @click="submitOrder"
              :disabled="saving"
              class="flex-1 px-4 py-3 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50"
            >
              {{ saving ? 'Odosielam...' : (isSubmitted ? 'Aktualizovat objednavku' : 'Odoslat objednavku') }}
            </button>
          </div>

          <!-- Cart details toggle -->
          <details class="mt-3">
            <summary class="text-sm text-gray-500 cursor-pointer">Zobrazit polozky v kosiku</summary>
            <div class="mt-2 text-sm">
              <div v-for="item in cartItems" :key="item.key" class="flex justify-between py-1 border-b border-gray-100">
                <span>{{ item.product_name }} ({{ item.variant }}) x{{ item.quantity }}</span>
                <span>{{ formatPrice(item.total) }}</span>
              </div>
            </div>
          </details>
        </div>
      </div>

      <!-- Spacer for fixed footer -->
      <div v-if="cartItems.length > 0" class="h-40"></div>
    </div>
  </div>
</template>
