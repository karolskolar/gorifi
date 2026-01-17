<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import api, { setCyclePassword, clearCyclePassword } from '../api'

const route = useRoute()

// Auth state
const authState = ref('loading') // 'loading' | 'login' | 'welcome-back' | 'authenticated'
const savedAuth = ref(null) // { cycleId, friendId, friendName } from localStorage

// Cycle/friend data
const cyclePublic = ref(null) // { cycle, friends }
const friend = ref(null)
const cycle = ref(null)
const products = ref([])
const order = ref(null)
const cart = ref({}) // { productId-variant: quantity }

// Form state
const selectedFriendId = ref('')
const password = ref('')
const rememberMe = ref(true)

// UI state
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const successMessage = ref('')
const authError = ref('')

const cycleId = computed(() => route.params.cycleId)

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

const STORAGE_KEY = 'gorifi_auth'

onMounted(async () => {
  await loadPublicData()
})

async function loadPublicData() {
  loading.value = true
  authState.value = 'loading'
  error.value = ''

  try {
    // Get public cycle info (no auth required)
    cyclePublic.value = await api.getCyclePublic(cycleId.value)

    // Check localStorage for saved auth
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        // Check if it's for this cycle
        if (parsed.cycleId === parseInt(cycleId.value)) {
          // Verify the friend still exists in this cycle
          const friendExists = cyclePublic.value.friends.find(f => f.id === parsed.friendId)
          if (friendExists) {
            savedAuth.value = parsed
            selectedFriendId.value = parsed.friendId
            authState.value = 'welcome-back'
          } else {
            // Friend no longer exists, clear storage
            localStorage.removeItem(STORAGE_KEY)
            authState.value = 'login'
          }
        } else {
          // Different cycle, show login
          authState.value = 'login'
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY)
        authState.value = 'login'
      }
    } else {
      authState.value = 'login'
    }
  } catch (e) {
    error.value = e.message
    authState.value = 'login'
  } finally {
    loading.value = false
  }
}

async function authenticate() {
  if (!selectedFriendId.value || !password.value) {
    authError.value = 'Vyberte meno a zadajte heslo'
    return
  }

  authError.value = ''
  loading.value = true

  try {
    // Validate password with server
    await api.authenticateCycle(cycleId.value, password.value, selectedFriendId.value)

    // Set password for subsequent requests
    setCyclePassword(password.value)

    // Save to localStorage if remember me is checked
    const selectedFriend = cyclePublic.value.friends.find(f => f.id === parseInt(selectedFriendId.value))
    if (rememberMe.value && selectedFriend) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        cycleId: parseInt(cycleId.value),
        friendId: parseInt(selectedFriendId.value),
        friendName: selectedFriend.name
      }))
      savedAuth.value = {
        cycleId: parseInt(cycleId.value),
        friendId: parseInt(selectedFriendId.value),
        friendName: selectedFriend.name
      }
    }

    // Load order data
    await loadOrderData()
    authState.value = 'authenticated'
  } catch (e) {
    authError.value = e.message
  } finally {
    loading.value = false
  }
}

async function loadOrderData() {
  // Get order data
  const orderData = await api.getOrderByFriend(cycleId.value, selectedFriendId.value)
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
}

function switchUser() {
  // Clear auth state and go back to login
  clearCyclePassword()
  localStorage.removeItem(STORAGE_KEY)
  savedAuth.value = null
  selectedFriendId.value = ''
  password.value = ''
  authState.value = 'login'
  friend.value = null
  order.value = null
  cart.value = {}
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

    const result = await api.updateOrderByFriend(cycleId.value, friend.value.id, items)
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
    const result = await api.submitOrderByFriend(cycleId.value, friend.value.id)
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
      <div class="max-w-4xl mx-auto px-4 py-4 flex justify-between items-center">
        <div>
          <h1 class="text-xl font-bold">Gorifi - Objednavka kavy</h1>
          <p v-if="authState === 'authenticated' && friend" class="text-amber-200 text-sm">
            {{ friend.name }} | {{ cycle?.name }}
          </p>
          <p v-else-if="cyclePublic" class="text-amber-200 text-sm">{{ cyclePublic.cycle.name }}</p>
        </div>
        <button
          v-if="authState === 'authenticated'"
          @click="switchUser"
          class="text-amber-200 hover:text-white text-sm underline"
        >
          Zmenit pouzivatela
        </button>
      </div>
    </header>

    <!-- Loading -->
    <div v-if="loading && authState === 'loading'" class="text-center py-12 text-gray-500">Nacitavam...</div>

    <!-- Global Error -->
    <div v-else-if="error && authState === 'loading'" class="max-w-4xl mx-auto px-4 py-12">
      <div class="bg-red-50 text-red-700 p-6 rounded-lg text-center">
        <h2 class="text-lg font-semibold mb-2">Chyba</h2>
        <p>{{ error }}</p>
      </div>
    </div>

    <!-- Login Form -->
    <div v-else-if="authState === 'login'" class="max-w-md mx-auto px-4 py-12">
      <div class="bg-white rounded-lg shadow-lg p-6">
        <h2 class="text-xl font-semibold text-gray-800 mb-6 text-center">Prihlasenie</h2>

        <div v-if="authError" class="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
          {{ authError }}
        </div>

        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Vyberte svoje meno</label>
            <select
              v-model="selectedFriendId"
              class="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
            >
              <option value="">-- Vyberte --</option>
              <option v-for="f in cyclePublic?.friends" :key="f.id" :value="f.id">
                {{ f.name }}
              </option>
            </select>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Heslo</label>
            <input
              v-model="password"
              type="password"
              placeholder="Zadajte heslo"
              class="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
              @keyup.enter="authenticate"
            />
          </div>

          <label class="flex items-center gap-2 cursor-pointer">
            <input v-model="rememberMe" type="checkbox" class="rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
            <span class="text-sm text-gray-600">Zapamatat si ma na tomto zariadeni</span>
          </label>

          <button
            @click="authenticate"
            :disabled="loading || !selectedFriendId || !password"
            class="w-full px-4 py-3 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ loading ? 'Overujem...' : 'Prihlasit sa' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Welcome Back -->
    <div v-else-if="authState === 'welcome-back'" class="max-w-md mx-auto px-4 py-12">
      <div class="bg-white rounded-lg shadow-lg p-6">
        <h2 class="text-xl font-semibold text-gray-800 mb-2 text-center">Vitajte spat!</h2>
        <p class="text-gray-600 text-center mb-6">{{ savedAuth?.friendName }}</p>

        <div v-if="authError" class="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
          {{ authError }}
        </div>

        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Heslo</label>
            <input
              v-model="password"
              type="password"
              placeholder="Zadajte heslo"
              class="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
              @keyup.enter="authenticate"
            />
          </div>

          <button
            @click="authenticate"
            :disabled="loading || !password"
            class="w-full px-4 py-3 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ loading ? 'Overujem...' : 'Pokracovat' }}
          </button>

          <button
            @click="switchUser"
            class="w-full px-4 py-2 text-gray-600 hover:text-gray-800 text-sm"
          >
            Nie som {{ savedAuth?.friendName }}? Zmenit pouzivatela
          </button>
        </div>
      </div>
    </div>

    <!-- Authenticated - Order Form -->
    <div v-else-if="authState === 'authenticated'" class="max-w-4xl mx-auto px-4 py-6">
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
