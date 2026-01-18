<script setup>
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import api, { setCyclePassword, clearCyclePassword } from '../api'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'

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

// Set page title
watchEffect(() => {
  document.title = 'Objednávka'
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
            selectedFriendId.value = String(parsed.friendId)
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
    successMessage.value = 'Košík bol uložený'

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
    error.value = 'Košík je prázdny'
    return
  }

  // First save the cart
  await saveCart()

  saving.value = true
  error.value = ''

  try {
    const result = await api.submitOrderByFriend(cycleId.value, friend.value.id)
    order.value = result.order
    successMessage.value = 'Objednávka bola odoslaná!'
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
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="bg-primary text-primary-foreground shadow sticky top-0 z-40 relative">
      <div class="max-w-4xl mx-auto px-4 py-3 flex justify-between items-center">
        <!-- Logo only when not authenticated, left-aligned info when authenticated -->
        <div v-if="authState === 'authenticated' && friend" class="flex flex-col">
          <span class="text-lg font-semibold">{{ friend.name }}</span>
          <span class="text-primary-foreground/70 text-sm">{{ cycle?.name }}</span>
        </div>
        <div v-else class="flex-1 flex justify-center">
          <img
            src="https://www.goriffee.com/wp-content/uploads/2024/02/01-GORIFFEE-Logo-RGB-400x110.png"
            alt="Goriffee"
            class="h-10 object-contain"
          />
        </div>
        <Button
          v-if="authState === 'authenticated'"
          variant="ghost"
          @click="switchUser"
          class="text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10"
        >
          Zmeniť používateľa
        </Button>
      </div>
    </header>

    <!-- Loading -->
    <div v-if="loading && authState === 'loading'" class="text-center py-12 text-muted-foreground">Načítavam...</div>

    <!-- Global Error -->
    <div v-else-if="error && authState === 'loading'" class="max-w-4xl mx-auto px-4 py-12">
      <Alert variant="destructive">
        <AlertDescription>
          <strong>Chyba:</strong> {{ error }}
        </AlertDescription>
      </Alert>
    </div>

    <!-- Login Form -->
    <div v-else-if="authState === 'login'" class="max-w-md mx-auto px-4 py-8">
      <!-- Three friends image -->
      <div class="flex justify-center mb-6">
        <img
          src="https://www.goriffee.com/wp-content/uploads/2025/01/goriffee_three_friends-1.png"
          alt="Goriffee Friends"
          class="h-32 object-contain"
        />
      </div>
      <Card>
        <CardHeader class="text-center">
          <CardTitle>Prihlásenie</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <Alert v-if="authError" variant="destructive">
            <AlertDescription>{{ authError }}</AlertDescription>
          </Alert>

          <div class="space-y-2">
            <Label>Vyberte svoje meno</Label>
            <Select v-model="selectedFriendId">
              <SelectTrigger>
                <SelectValue placeholder="-- Vyberte --" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="f in cyclePublic?.friends" :key="f.id" :value="String(f.id)">
                  {{ f.name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label>Heslo</Label>
            <Input
              v-model="password"
              type="password"
              placeholder="Zadajte heslo"
              @keyup.enter="authenticate"
            />
          </div>

          <label class="flex items-center gap-2 cursor-pointer">
            <input v-model="rememberMe" type="checkbox" class="rounded border-input" />
            <span class="text-sm text-muted-foreground">Zapamätať si ma na tomto zariadení</span>
          </label>

          <Button
            @click="authenticate"
            :disabled="loading || !selectedFriendId || !password"
            class="w-full"
          >
            {{ loading ? 'Overujem...' : 'Prihlásiť sa' }}
          </Button>
        </CardContent>
      </Card>
    </div>

    <!-- Welcome Back -->
    <div v-else-if="authState === 'welcome-back'" class="max-w-md mx-auto px-4 py-8">
      <!-- Three friends image -->
      <div class="flex justify-center mb-6">
        <img
          src="https://www.goriffee.com/wp-content/uploads/2025/01/goriffee_three_friends-1.png"
          alt="Goriffee Friends"
          class="h-32 object-contain"
        />
      </div>
      <Card>
        <CardHeader class="text-center">
          <CardTitle>Vitajte späť!</CardTitle>
          <CardDescription>{{ savedAuth?.friendName }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <Alert v-if="authError" variant="destructive">
            <AlertDescription>{{ authError }}</AlertDescription>
          </Alert>

          <div class="space-y-2">
            <Label>Heslo</Label>
            <Input
              v-model="password"
              type="password"
              placeholder="Zadajte heslo"
              @keyup.enter="authenticate"
            />
          </div>

          <Button
            @click="authenticate"
            :disabled="loading || !password"
            class="w-full"
          >
            {{ loading ? 'Overujem...' : 'Pokračovať' }}
          </Button>

          <Button
            variant="ghost"
            @click="switchUser"
            class="w-full"
          >
            Nie som {{ savedAuth?.friendName }}? Zmeniť používateľa
          </Button>
        </CardContent>
      </Card>
    </div>

    <!-- Authenticated - Order Form -->
    <div v-else-if="authState === 'authenticated'" class="max-w-4xl mx-auto px-4 py-6">
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

      <!-- Products by roast type -->
      <div v-for="(groupProducts, roastType) in groupedProducts" :key="roastType" class="mb-8">
        <h2 class="text-lg font-semibold text-foreground mb-4 sticky top-16 bg-background py-2 z-30">
          {{ roastType }}
        </h2>

        <div class="space-y-3">
          <Card
            v-for="product in groupProducts"
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
                  <Badge v-if="product.purpose" variant="secondary" class="mt-1">{{ product.purpose }}</Badge>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-4">
                <!-- 250g variant -->
                <div
                  v-if="product.price_250g"
                  :class="[
                    'rounded-lg p-3 transition-colors',
                    getQuantity(product.id, '250g') > 0
                      ? 'bg-primary/10 border-2 border-primary'
                      : 'border bg-background'
                  ]"
                >
                  <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-medium">250g</span>
                    <span class="text-sm text-primary font-semibold">{{ formatPrice(product.price_250g) }}</span>
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
                      : 'border bg-background'
                  ]"
                >
                  <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-medium">1kg</span>
                    <span class="text-sm text-primary font-semibold">{{ formatPrice(product.price_1kg) }}</span>
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
      </div>

      <!-- Sticky cart footer -->
      <div v-if="cartItems.length > 0" class="fixed bottom-0 left-0 right-0 bg-card shadow-lg border-t z-50">
        <div class="max-w-4xl mx-auto px-4 py-4">
          <div class="flex justify-between items-center mb-3">
            <div>
              <span class="text-muted-foreground">Položiek: {{ cartItems.length }}</span>
              <span class="mx-2">|</span>
              <span class="font-semibold text-lg">Celkom: {{ formatPrice(cartTotal) }}</span>
            </div>
          </div>

          <div v-if="!isLocked" class="flex gap-3">
            <Button
              variant="outline"
              @click="saveCart"
              :disabled="saving"
              class="flex-1"
            >
              {{ saving ? 'Ukladám...' : 'Uložiť košík' }}
            </Button>
            <Button
              @click="submitOrder"
              :disabled="saving"
              class="flex-1"
            >
              {{ saving ? 'Odosielam...' : (isSubmitted ? 'Aktualizovať objednávku' : 'Odoslať objednávku') }}
            </Button>
          </div>

          <!-- Cart details toggle -->
          <details class="mt-3">
            <summary class="text-sm text-muted-foreground cursor-pointer">Zobraziť položky v košíku</summary>
            <div class="mt-2 text-sm max-h-40 overflow-y-auto">
              <div v-for="item in cartItems" :key="item.key" class="flex justify-between py-1 border-b border-border">
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
