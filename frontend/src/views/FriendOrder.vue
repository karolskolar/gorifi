<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watchEffect, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import api, { getFriendsPassword, getFriendsAuthInfo, getFriendsToken } from '../api'
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
import PaymentModal from '@/components/PaymentModal.vue'
import { encode as bysquareEncode, PaymentOptions, CurrencyCode, Version } from 'bysquare'
import QRCode from 'qrcode'

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
const showLeaveModal = ref(false) // Confirmation modal when leaving with unsaved changes
const pendingNavigation = ref(null) // Store pending navigation path
const leaveConfirmed = ref(false) // Flag to bypass navigation guard after confirming leave
const changesNotificationDismissed = ref(false) // Track if "changes not saved" notification was dismissed

// Stock availability state
const availability = ref({}) // { productId: { stock_limit_g, ordered_g, remaining_g } }

// Variant weight map in grams
const variantGrams = { '150g': 150, '200g': 200, '250g': 250, '500g': 500, '1kg': 1000, '20pc5g': 100 }

// Pickup location state
const pickupLocations = ref([])
const showPickupModal = ref(false)
const selectedPickupLocationId = ref(null) // null = "Iné"
const pickupLocationNote = ref('')

// Parcel delivery state
const deliveryMethod = ref('pickup') // 'pickup' or 'packeta'
const packetaAddress = ref('')
const savePacketaAsDefault = ref(false)

// Payment state
const paymentIban = ref('')
const paymentRevolutUsername = ref('')
const showPaymentModal = ref(false)
const successQrDataUrl = ref(null)
const hasPaymentSettings = computed(() => !!(paymentIban.value || paymentRevolutUsername.value))
const paymentReference = computed(() => {
  const friendName = friend.value?.name || ''
  const cycleName = cycle.value?.name || ''
  return `${friendName} / ${cycleName}`
})

const cycleId = computed(() => route.params.cycleId)

const isLocked = computed(() => cycle.value?.status === 'planned' || cycle.value?.status === 'locked' || cycle.value?.status === 'completed')
const isSubmitted = computed(() => order.value?.status === 'submitted')
const markupRatio = computed(() => cycle.value?.markup_ratio || 1.0)
const isBakery = computed(() => cycle.value?.type === 'bakery')

// Check if there are unsaved changes that would be lost on leaving:
// 1. Order is submitted but cart differs from last submission
// 2. No order exists but cart has items (items not saved yet)
const hasUnsavedChanges = computed(() => {
  // Case 1: No order exists but cart has items - these would be lost
  if (!order.value && cartItems.value.length > 0) {
    return true
  }

  // Case 2: Order is submitted but cart differs from last submission
  if (isSubmitted.value && lastSubmittedCart.value) {
    const currentKeys = Object.keys(cart.value).filter(k => cart.value[k] > 0)
    const lastKeys = Object.keys(lastSubmittedCart.value).filter(k => lastSubmittedCart.value[k] > 0)
    if (currentKeys.length !== lastKeys.length) return true
    for (const key of currentKeys) {
      if (cart.value[key] !== lastSubmittedCart.value[key]) return true
    }
  }

  return false
})

// Alias for backward compatibility with existing template references
const hasUnsubmittedChanges = computed(() => {
  // For the status notification, only show when order is submitted but has changes
  if (!isSubmitted.value || !lastSubmittedCart.value) return false
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
        if (variant === 'unit') basePrice = product.price_unit
        else if (variant === '1kg') basePrice = product.price_1kg
        else if (variant === '500g') basePrice = product.price_500g
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
          variant_label: product.variant_label || null,
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

// Total including delivery fee (for payment)
const paymentTotal = computed(() => {
  const deliveryFee = order.value?.delivery_fee || 0
  return cartTotal.value + deliveryFee
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

      // Find all products with same source_bakery_product_id
      const variants = purposeProducts.filter(p =>
        p.source_bakery_product_id && p.source_bakery_product_id === product.source_bakery_product_id
      )

      if (variants.length > 1) {
        // Multi-variant product: first variant provides the card info
        groups.push({ ...variants[0], _variants: variants })
      } else {
        // Single product (no grouping needed)
        groups.push({ ...product, _variants: [product] })
      }
    }
    result[purpose] = groups
  }
  return result
})

function getGroupQuantityTotal(variants) {
  return variants.reduce((sum, v) => sum + getQuantity(v.id, 'unit'), 0)
}

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
  const isActive = activeTab.value === purpose
  if (!isActive) return ''
  if (purpose === 'Slané') return 'bg-amber-600 text-white data-[state=active]:bg-amber-600 data-[state=active]:text-white'
  if (purpose === 'Sladké') return 'bg-pink-600 text-white data-[state=active]:bg-pink-600 data-[state=active]:text-white'
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
  // Check if authenticated (token or password)
  if (!getFriendsToken() && !getFriendsPassword()) {
    // Try to restore from localStorage
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) {
      router.push('/')
      return
    }
    try {
      const parsed = JSON.parse(stored)
      if (!parsed.token && !parsed.password) {
        router.push('/')
        return
      }
      // Auth will be restored by FriendPortal, redirect there
      router.push('/')
      return
    } catch {
      router.push('/')
      return
    }
  }

  await loadOrderData()

  // Load pickup locations and payment settings
  try {
    const [locations, paymentSettings] = await Promise.all([
      api.getPickupLocations(cycle.value?.type || 'coffee'),
      api.getPaymentSettings()
    ])
    pickupLocations.value = locations
    paymentIban.value = paymentSettings.paymentIban || ''
    paymentRevolutUsername.value = paymentSettings.paymentRevolutUsername || ''
  } catch (e) {
    // Non-critical, proceed without locations/payment
  }
})

// Set page title
watchEffect(() => {
  document.title = cycle.value?.name ? `${cycle.value.name} - Objednávka` : 'Objednávka'
})

async function loadOrderData() {
  loading.value = true
  error.value = ''

  try {
    // Get friend info from localStorage or in-memory auth
    let friendId = null
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      friendId = parsed.friendId
    } else {
      // Try in-memory auth info (when "remember me" was not checked)
      const authInfo = getFriendsAuthInfo()
      if (authInfo) {
        friendId = authInfo.friendId
      }
    }

    if (!friendId) {
      router.push('/')
      return
    }

    // Get order data
    const orderData = await api.getOrderByFriend(cycleId.value, friendId)
    order.value = orderData.order
    cycle.value = orderData.cycle
    friend.value = orderData.friend

    // Get products and availability
    products.value = await api.getProducts(cycleId.value)
    await loadAvailability(friendId)

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

async function loadAvailability(friendId) {
  try {
    const data = await api.getProductAvailability(cycleId.value, friendId)
    const map = {}
    for (const item of data) {
      map[item.product_id] = item
    }
    availability.value = map
  } catch (e) {
    // Non-critical, proceed without availability data
  }
}

// Get grams of a product currently in the friend's cart
function getCartGramsForProduct(productId) {
  let grams = 0
  for (const [key, qty] of Object.entries(cart.value)) {
    if (qty <= 0) continue
    const [pid, variant] = key.split('-')
    if (parseInt(pid) === productId) {
      grams += (variantGrams[variant] || 0) * qty
    }
  }
  return grams
}

// Check if adding one more of this variant would exceed stock limit
function canIncrement(productId, variant) {
  const avail = availability.value[productId]
  if (!avail) return true // No stock limit
  const cartGrams = getCartGramsForProduct(productId)
  const addGrams = variantGrams[variant] || 0
  return (avail.remaining_g - cartGrams - addGrams) >= 0
}

// Get remaining grams available for a product (accounting for cart)
function getRemainingGrams(productId) {
  const avail = availability.value[productId]
  if (!avail) return null
  return Math.max(0, avail.remaining_g - getCartGramsForProduct(productId))
}

function goBack() {
  // If there are unsaved changes, show confirmation modal
  if (hasUnsavedChanges.value) {
    pendingNavigation.value = '/'
    showLeaveModal.value = true
    return
  }
  router.push('/')
}

function confirmLeave() {
  showLeaveModal.value = false
  leaveConfirmed.value = true // Bypass navigation guard
  if (pendingNavigation.value) {
    router.push(pendingNavigation.value)
    pendingNavigation.value = null
  }
}

function cancelLeave() {
  showLeaveModal.value = false
  pendingNavigation.value = null
}

// Navigation guard - warn when leaving with unsaved changes
onBeforeRouteLeave((to, from, next) => {
  if (leaveConfirmed.value) {
    leaveConfirmed.value = false // Reset for next time
    next() // Allow navigation after user confirmed
  } else if (hasUnsavedChanges.value && !showLeaveModal.value) {
    pendingNavigation.value = to.fullPath
    showLeaveModal.value = true
    next(false) // Cancel navigation
  } else {
    next() // Allow navigation
  }
})

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
  if (!canIncrement(productId, variant)) return
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

// Auto-save cart when it changes (debounced) - only for existing draft orders
watch(cart, () => {
  // Reset the "changes not saved" notification dismissed state when cart changes
  // This ensures the notification reappears if user makes more changes after dismissing
  changesNotificationDismissed.value = false

  // Skip auto-save during initial load, when locked, when order is already submitted,
  // or when there's no existing order (don't auto-create orders, only auto-save existing drafts)
  // New orders are only created when user explicitly submits
  if (!initialLoadComplete.value || isLocked.value || !friend.value || isSubmitted.value || !order.value) return

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

  // Only save if there's an existing order to delete
  // If there's no order yet (user just added items without saving), no need to save
  if (order.value) {
    await saveCart(true)
  }

  // Reset the snapshot since we've now saved an empty cart
  // This prevents the "unsaved changes" warning from showing
  lastSubmittedCart.value = {}

  // Mark as confirmed to bypass navigation guard
  leaveConfirmed.value = true

  // Redirect back to cycle list
  router.push('/')
}

async function submitOrder() {
  if (isLocked.value) return
  if (cartItems.value.length === 0) {
    error.value = 'Košík je prázdny'
    return
  }

  const hasPickupLocations = pickupLocations.value.length > 0
  const hasParcel = cycle.value?.parcel_enabled

  if (!hasPickupLocations && !hasParcel) {
    // No modal needed, submit directly
    await doSubmitOrder()
    return
  }

  // Pre-select based on existing order state
  if (order.value?.packeta_address) {
    deliveryMethod.value = 'packeta'
    packetaAddress.value = order.value.packeta_address
    savePacketaAsDefault.value = false
  } else if (order.value?.pickup_location_id) {
    deliveryMethod.value = 'pickup'
    selectedPickupLocationId.value = order.value.pickup_location_id
    pickupLocationNote.value = ''
  } else if (order.value?.pickup_location_note) {
    deliveryMethod.value = 'pickup'
    selectedPickupLocationId.value = null
    pickupLocationNote.value = order.value.pickup_location_note
  } else {
    // Default: pickup if locations exist, otherwise packeta
    deliveryMethod.value = hasPickupLocations ? 'pickup' : 'packeta'
    selectedPickupLocationId.value = null
    pickupLocationNote.value = ''
    // Pre-fill Packeta address from friend profile
    packetaAddress.value = friend.value?.packeta_address || ''
    savePacketaAsDefault.value = false
  }

  showPickupModal.value = true
}

async function doSubmitOrder() {
  // Capture state before submitting
  const wasAlreadySubmitted = isSubmitted.value

  // First save the cart
  await saveCart()

  saving.value = true
  error.value = ''

  try {
    const pickupData = deliveryMethod.value === 'packeta'
      ? {
          use_parcel_delivery: true,
          packeta_address: packetaAddress.value.trim(),
          pickup_location_id: null,
          pickup_location_note: null
        }
      : {
          use_parcel_delivery: false,
          pickup_location_id: selectedPickupLocationId.value || null,
          pickup_location_note: selectedPickupLocationId.value ? null : (pickupLocationNote.value || null)
        }
    const result = await api.submitOrderByFriend(cycleId.value, friend.value.id, pickupData)
    order.value = result.order
    // Store snapshot of submitted cart for change detection
    lastSubmittedCart.value = { ...cart.value }
    successModalMessage.value = wasAlreadySubmitted
      ? 'Vaša objednávka bola aktualizovaná!'
      : 'Vaša objednávka bola úspešne odoslaná!'
    showSuccessModal.value = true
    generateSuccessQr()
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

async function generateSuccessQr() {
  if (!paymentIban.value) return
  try {
    const today = new Date()
    const dateStr = today.getFullYear().toString()
      + (today.getMonth() + 1).toString().padStart(2, '0')
      + today.getDate().toString().padStart(2, '0')

    const qrString = bysquareEncode({
      invoiceId: '',
      payments: [{
        type: PaymentOptions.PaymentOrder,
        amount: paymentTotal.value,
        currencyCode: CurrencyCode.EUR,
        paymentDueDate: dateStr,
        variableSymbol: '',
        constantSymbol: '',
        specificSymbol: '',
        originatorsReferenceInformation: '',
        paymentNote: paymentReference.value || '',
        bankAccounts: [{ iban: paymentIban.value.replace(/\s/g, ''), bic: '' }],
        beneficiary: { name: 'Gorifi', street: '', city: '' }
      }]
    }, { version: Version['1.0.0'] })
    successQrDataUrl.value = await QRCode.toDataURL(qrString, { errorCorrectionLevel: 'M', width: 256, margin: 2 })
  } catch (e) {
    console.error('QR generation failed:', e)
  }
}

async function confirmPickupAndSubmit() {
  // Optionally save Packeta address to profile
  if (deliveryMethod.value === 'packeta' && savePacketaAsDefault.value && packetaAddress.value.trim()) {
    try {
      await api.updateFriendProfile(friend.value.id, {
        packeta_address: packetaAddress.value.trim()
      })
    } catch (e) {
      // Non-critical, proceed with order
    }
  }
  showPickupModal.value = false
  doSubmitOrder()
}

function handleSuccessModalClose() {
  showSuccessModal.value = false
  leaveConfirmed.value = true // Bypass navigation guard
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

      <Alert v-if="isSubmitted && !isLocked && cartItems.length > 0" class="mb-6 border-green-500 bg-green-50 text-green-800">
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
              v-for="product in (isBakery ? groupedBakeryProducts[purpose] : groupedProducts[purpose])"
              :key="product.id"
            >
              <!-- Bakery product card with variant support -->
              <CardContent v-if="isBakery && product.price_unit" class="p-0">
                <div
                  :class="[
                    'flex rounded-lg overflow-hidden transition-colors',
                    getGroupQuantityTotal(product._variants) > 0
                      ? 'ring-2 ring-primary'
                      : ''
                  ]"
                >
                  <!-- Product image - full height left side -->
                  <div class="w-28 flex-shrink-0 bg-muted flex items-center justify-center">
                    <img v-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                    <svg v-else class="w-8 h-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <!-- Product info + variant rows -->
                  <div class="flex-1 min-w-0 p-3 flex flex-col">
                    <div class="flex justify-between items-start gap-2">
                      <div class="min-w-0 flex-1">
                        <div class="flex items-baseline gap-2">
                          <h3 class="font-semibold text-foreground">{{ product.name }}</h3>
                          <span v-if="product.description2" class="text-sm text-muted-foreground">{{ product.description2 }}</span>
                        </div>
                        <p v-if="product.description1" class="text-sm text-muted-foreground mt-0.5">{{ product.description1 }}</p>
                        <details v-if="product.composition" class="mt-1">
                          <summary class="text-xs text-muted-foreground/70 cursor-pointer select-none">Zloženie</summary>
                          <p class="text-xs text-muted-foreground/70 mt-0.5">{{ product.composition }}</p>
                        </details>
                      </div>
                    </div>
                    <!-- Variant rows -->
                    <div class="mt-auto pt-2 space-y-1.5">
                      <div v-for="v in product._variants" :key="v.id" class="flex items-center justify-between">
                        <div class="text-sm">
                          <span class="font-semibold text-primary">{{ formatPrice(applyMarkup(v.price_unit)) }}</span>
                          <span v-if="v.variant_label" class="text-muted-foreground ml-1">/ {{ v.variant_label }}</span>
                        </div>
                        <div class="flex items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="icon"
                            @click="decrement(v.id, 'unit')"
                            :disabled="isLocked || getQuantity(v.id, 'unit') === 0"
                            class="h-8 w-8 rounded-full"
                          >
                            -
                          </Button>
                          <span class="w-6 text-center font-semibold text-sm">{{ getQuantity(v.id, 'unit') }}</span>
                          <Button
                            variant="outline"
                            size="icon"
                            @click="increment(v.id, 'unit')"
                            :disabled="isLocked"
                            class="h-8 w-8 rounded-full"
                          >
                            +
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>

              <!-- Coffee product card -->
              <CardContent v-else class="p-4">
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
                    <div class="flex items-center gap-2">
                      <h3 class="font-semibold text-foreground">{{ product.name }}</h3>
                      <span v-if="product.roast_type" class="text-xs text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded-full whitespace-nowrap">{{ product.roast_type }}</span>
                      <span v-if="product.roastery" class="text-xs bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">{{ product.roastery }}</span>
                    </div>
                    <p v-if="product.description1" class="text-sm text-muted-foreground">{{ product.description1 }}</p>
                    <p v-if="product.description2" class="text-sm text-muted-foreground/70 mt-1 line-clamp-2">{{ product.description2 }}</p>
                  </div>
                </div>

                <!-- Capsule variant (20 ks × 5g) -->
                <div v-if="product.price_20pc5g" class="grid grid-cols-1 gap-4">
                  <div
                    :class="[
                      'rounded-lg p-2 transition-colors',
                      getQuantity(product.id, '20pc5g') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-1">
                      <span class="text-sm font-medium">20 ks × 5g</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_20pc5g)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-2">
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
                        :disabled="isLocked || !canIncrement(product.id, '20pc5g')"
                        class="h-8 w-8 rounded-full"
                      >
                        +
                      </Button>
                    </div>
                  </div>
                </div>

                <!-- Stock limit indicator -->
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

                <!-- Weight variants (150g / 200g / 250g / 500g / 1kg) -->
                <div v-if="!product.price_20pc5g" class="grid grid-cols-2 gap-4">
                  <!-- 150g variant -->
                  <div
                    v-if="product.price_150g"
                    :class="[
                      'rounded-lg p-2 transition-colors',
                      getQuantity(product.id, '150g') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-1">
                      <span class="text-sm font-medium">150g</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_150g)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-2">
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
                        :disabled="isLocked || !canIncrement(product.id, '150g')"
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
                      'rounded-lg p-2 transition-colors',
                      getQuantity(product.id, '200g') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-1">
                      <span class="text-sm font-medium">200g</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_200g)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-2">
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
                        :disabled="isLocked || !canIncrement(product.id, '200g')"
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
                      'rounded-lg p-2 transition-colors',
                      getQuantity(product.id, '250g') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-1">
                      <span class="text-sm font-medium">250g</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_250g)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-2">
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
                        :disabled="isLocked || !canIncrement(product.id, '250g')"
                        class="h-8 w-8 rounded-full"
                      >
                        +
                      </Button>
                    </div>
                  </div>

                  <!-- 500g variant -->
                  <div
                    v-if="product.price_500g"
                    :class="[
                      'rounded-lg p-2 transition-colors',
                      getQuantity(product.id, '500g') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-1">
                      <span class="text-sm font-medium">500g</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_500g)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        @click="decrement(product.id, '500g')"
                        :disabled="isLocked || getQuantity(product.id, '500g') === 0"
                        class="h-8 w-8 rounded-full"
                      >
                        -
                      </Button>
                      <span class="w-8 text-center font-semibold">{{ getQuantity(product.id, '500g') }}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        @click="increment(product.id, '500g')"
                        :disabled="isLocked || !canIncrement(product.id, '500g')"
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
                      'rounded-lg p-2 transition-colors',
                      getQuantity(product.id, '1kg') > 0
                        ? 'bg-primary/10 border-2 border-primary'
                        : 'border bg-card'
                    ]"
                  >
                    <div class="flex justify-between items-center mb-1">
                      <span class="text-sm font-medium">1kg</span>
                      <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_1kg)) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-2">
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
                        :disabled="isLocked || !canIncrement(product.id, '1kg')"
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
          v-for="product in (isBakery ? groupedBakeryProducts[availablePurposes[0]] : groupedProducts[availablePurposes[0]])"
          :key="product.id"
        >
          <!-- Bakery product card with variant support -->
          <CardContent v-if="isBakery && product.price_unit" class="p-0">
            <div
              :class="[
                'flex rounded-lg overflow-hidden transition-colors',
                getGroupQuantityTotal(product._variants) > 0
                  ? 'ring-2 ring-primary'
                  : ''
              ]"
            >
              <!-- Product image - full height left side -->
              <div class="w-28 flex-shrink-0 bg-muted flex items-center justify-center">
                <img v-if="product.image" :src="product.image" class="w-full h-full object-cover" />
                <svg v-else class="w-8 h-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <!-- Product info + variant rows -->
              <div class="flex-1 min-w-0 p-3 flex flex-col">
                <div class="flex justify-between items-start gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline gap-2">
                      <h3 class="font-semibold text-foreground">{{ product.name }}</h3>
                      <span v-if="product.description2" class="text-sm text-muted-foreground">{{ product.description2 }}</span>
                    </div>
                    <p v-if="product.description1" class="text-sm text-muted-foreground mt-0.5">{{ product.description1 }}</p>
                    <details v-if="product.composition" class="mt-1">
                      <summary class="text-xs text-muted-foreground/70 cursor-pointer select-none">Zloženie</summary>
                      <p class="text-xs text-muted-foreground/70 mt-0.5">{{ product.composition }}</p>
                    </details>
                  </div>
                </div>
                <!-- Variant rows -->
                <div class="mt-auto pt-2 space-y-1.5">
                  <div v-for="v in product._variants" :key="v.id" class="flex items-center justify-between">
                    <div class="text-sm">
                      <span class="font-semibold text-primary">{{ formatPrice(applyMarkup(v.price_unit)) }}</span>
                      <span v-if="v.variant_label" class="text-muted-foreground ml-1">/ {{ v.variant_label }}</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="icon"
                        @click="decrement(v.id, 'unit')"
                        :disabled="isLocked || getQuantity(v.id, 'unit') === 0"
                        class="h-8 w-8 rounded-full"
                      >
                        -
                      </Button>
                      <span class="w-6 text-center font-semibold text-sm">{{ getQuantity(v.id, 'unit') }}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        @click="increment(v.id, 'unit')"
                        :disabled="isLocked"
                        class="h-8 w-8 rounded-full"
                      >
                        +
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>

          <!-- Coffee product card -->
          <CardContent v-else class="p-4">
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
                  'rounded-lg p-2 transition-colors',
                  getQuantity(product.id, '20pc5g') > 0
                    ? 'bg-primary/10 border-2 border-primary'
                    : 'border bg-card'
                ]"
              >
                <div class="flex justify-between items-center mb-1">
                  <span class="text-sm font-medium">20 ks × 5g</span>
                  <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_20pc5g)) }}</span>
                </div>
                <div class="flex items-center justify-center gap-2">
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
                  'rounded-lg p-2 transition-colors',
                  getQuantity(product.id, '150g') > 0
                    ? 'bg-primary/10 border-2 border-primary'
                    : 'border bg-card'
                ]"
              >
                <div class="flex justify-between items-center mb-1">
                  <span class="text-sm font-medium">150g</span>
                  <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_150g)) }}</span>
                </div>
                <div class="flex items-center justify-center gap-2">
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
                  'rounded-lg p-2 transition-colors',
                  getQuantity(product.id, '200g') > 0
                    ? 'bg-primary/10 border-2 border-primary'
                    : 'border bg-card'
                ]"
              >
                <div class="flex justify-between items-center mb-1">
                  <span class="text-sm font-medium">200g</span>
                  <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_200g)) }}</span>
                </div>
                <div class="flex items-center justify-center gap-2">
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
                  'rounded-lg p-2 transition-colors',
                  getQuantity(product.id, '250g') > 0
                    ? 'bg-primary/10 border-2 border-primary'
                    : 'border bg-card'
                ]"
              >
                <div class="flex justify-between items-center mb-1">
                  <span class="text-sm font-medium">250g</span>
                  <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_250g)) }}</span>
                </div>
                <div class="flex items-center justify-center gap-2">
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
                  'rounded-lg p-2 transition-colors',
                  getQuantity(product.id, '1kg') > 0
                    ? 'bg-primary/10 border-2 border-primary'
                    : 'border bg-card'
                ]"
              >
                <div class="flex justify-between items-center mb-1">
                  <span class="text-sm font-medium">1kg</span>
                  <span class="text-sm text-primary font-semibold">{{ formatPrice(applyMarkup(product.price_1kg)) }}</span>
                </div>
                <div class="flex items-center justify-center gap-2">
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
        <div class="max-w-4xl mx-auto px-4 py-2">
          <div v-if="cycle?.expected_date" class="text-xs text-primary mb-1">
            📅 Objednávka do: <span class="font-medium">{{ cycle.expected_date }}</span>
          </div>

          <!-- Order status notifications -->
          <div v-if="!isLocked && cartItems.length > 0 && !isSubmitted" class="mb-1.5 px-2 py-1.5 bg-yellow-50 border border-yellow-300 rounded text-yellow-800 text-xs flex items-center gap-1.5">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <strong>Objednávka ešte nebola odoslaná.</strong>
          </div>

          <div v-else-if="!isLocked && hasUnsubmittedChanges && !changesNotificationDismissed" class="mb-1.5 px-2 py-1.5 bg-orange-50 border border-orange-300 rounded text-orange-800 text-xs flex items-center gap-1.5">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span class="flex-1"><strong>Zmeny neboli odoslané.</strong> Stlačte "Aktualizovať objednávku".</span>
            <button
              @click="changesNotificationDismissed = true"
              class="flex-shrink-0 p-0.5 hover:bg-orange-100 rounded"
              title="Zavrieť"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="flex justify-between items-center mb-1.5">
            <div class="flex items-center gap-1.5">
              <span class="text-xs text-muted-foreground">Položiek: {{ cartItems.length }}</span>
              <span class="mx-1 text-xs">|</span>
              <span class="font-semibold text-sm">Celkom: {{ formatPrice(paymentTotal) }}</span>
              <span v-if="autoSaving" class="text-xs text-muted-foreground animate-pulse">Ukladám...</span>
            </div>
          </div>

          <div v-if="!isLocked" class="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              @click="cancelOrder"
              :disabled="saving || cartItems.length === 0"
              class="flex-1 h-8 text-xs border-red-500 text-red-600 hover:bg-red-50 hover:text-red-700"
            >
              Zrušiť
            </Button>
            <Button
              v-if="isSubmitted && hasPaymentSettings"
              variant="outline"
              size="sm"
              @click="showPaymentModal = true"
              class="flex-1 h-8 text-xs border-green-500 text-green-600 hover:bg-green-50 hover:text-green-700"
            >
              Zaplatiť
            </Button>
            <Button
              size="sm"
              @click="submitOrder"
              :disabled="saving || cartItems.length === 0"
              class="flex-1 h-8 text-xs"
            >
              {{ saving ? 'Odosielám...' : (isSubmitted ? 'Aktualizovať' : 'Odoslať') }}
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
                    'bg-amber-100 text-amber-700': purpose === 'Kapsule' || purpose === 'Slané',
                    'bg-pink-100 text-pink-700': purpose === 'Sladké',
                    'bg-muted text-muted-foreground': !['Espresso', 'Filter', 'Kapsule', 'Slané', 'Sladké'].includes(purpose)
                  }"
                >
                  {{ purpose }}
                </div>
                <div v-for="item in items" :key="item.key" class="flex justify-between py-1 border-b border-border">
                  <span>{{ item.product_name }} ({{ item.variant_label ? item.variant_label : (item.variant === 'unit' ? 'ks' : item.variant) }}) x{{ item.quantity }}</span>
                  <span>{{ formatPrice(item.total) }}</span>
                </div>
              </template>
              <!-- Delivery fee line item -->
              <div v-if="order?.delivery_fee" class="flex justify-between py-1 border-b border-border mt-2 text-red-600">
                <span>📦 Doručenie Packetou</span>
                <span>{{ formatPrice(order.delivery_fee) }}</span>
              </div>
            </div>
          </details>
        </div>
      </div>

      <!-- Spacer for fixed footer -->
      <div class="h-48"></div>
    </div>

    <!-- Success Modal (with inline payment details) -->
    <Dialog :open="showSuccessModal" @update:open="val => !val && handleSuccessModalClose()">
      <DialogContent class="sm:max-w-md max-h-[90vh] overflow-y-auto">
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

        <!-- Inline payment details -->
        <div v-if="hasPaymentSettings" class="space-y-3 pt-2">
          <p class="text-sm font-medium text-center">
            Suma na úhradu: <strong>{{ formatPrice(paymentTotal) }}</strong>
            <span v-if="order?.delivery_fee" class="block text-xs text-muted-foreground mt-0.5">
              ({{ formatPrice(cartTotal) }} + {{ formatPrice(order.delivery_fee) }} doručenie)
            </span>
          </p>

          <a
            v-if="paymentRevolutUsername"
            :href="`https://revolut.me/${paymentRevolutUsername}`"
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center justify-center gap-2 w-full px-4 py-3 bg-[#0075EB] hover:bg-[#0066cc] text-white rounded-lg font-medium transition-colors"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.1 6.8c-.3-1.2-1-2.2-2-2.9-.9-.7-2.1-1-3.3-1H6.2L4 20.1h4.1l1-5.5h3.7c1.6 0 3-.5 4.1-1.4 1.1-.9 1.9-2.2 2.2-3.8l.5-2.6zM16 9.2l-.2 1c-.2.9-.6 1.5-1.2 2-.6.5-1.4.7-2.3.7H9.1l1-5.5h3.2c.7 0 1.2.2 1.6.6.4.4.5.9.4 1.5l-.3 1.7z"/>
            </svg>
            Zaplatiť cez Revolut
          </a>

          <div v-if="paymentIban" class="text-center space-y-2">
            <p class="text-sm text-muted-foreground">Pay by Square (QR kód pre bankovú appku)</p>
            <div v-if="successQrDataUrl" class="flex justify-center">
              <img :src="successQrDataUrl" alt="Pay by Square QR" class="w-48 h-48" />
            </div>
            <div v-else class="py-4 text-sm text-muted-foreground animate-pulse">
              Generujem QR kod...
            </div>
            <p class="text-xs text-muted-foreground">IBAN: {{ paymentIban }}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="handleSuccessModalClose" class="w-full">
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Payment Modal (for footer button) -->
    <PaymentModal
      :open="showPaymentModal"
      :amount="paymentTotal"
      :reference="paymentReference"
      :iban="paymentIban"
      :revolut-username="paymentRevolutUsername"
      @close="showPaymentModal = false"
    />

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

    <!-- Leave Confirmation Modal (unsaved changes) -->
    <Dialog :open="showLeaveModal" @update:open="showLeaveModal = $event">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <svg class="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Neuložené zmeny
          </DialogTitle>
          <DialogDescription class="text-base">
            Máte neuložené zmeny v objednávke. Naozaj chcete opustiť stránku? Zmeny nebudú uložené.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter class="flex gap-2">
          <Button variant="outline" @click="cancelLeave" class="flex-1">
            Zostať
          </Button>
          <Button @click="confirmLeave" class="flex-1 bg-orange-600 hover:bg-orange-700">
            Opustiť
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Delivery Method Modal -->
    <Dialog :open="showPickupModal" @update:open="showPickupModal = $event">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Spôsob prevzatia</DialogTitle>
          <DialogDescription class="text-base">
            Vyberte, ako chcete dostať objednávku.
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-3 py-2">
          <!-- Top-level choice: pickup vs packeta -->
          <div v-if="pickupLocations.length > 0 && cycle?.parcel_enabled" class="space-y-2">
            <label
              :class="[
                'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                deliveryMethod === 'pickup' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" value="pickup" v-model="deliveryMethod" />
              <div class="font-medium">Osobný odber</div>
            </label>
            <label
              :class="[
                'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                deliveryMethod === 'packeta' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" value="packeta" v-model="deliveryMethod" />
              <div>
                <span class="font-medium">Doručenie Packetou</span>
                <span v-if="cycle?.parcel_fee" class="text-sm text-muted-foreground ml-1">(+{{ formatPrice(cycle.parcel_fee) }})</span>
              </div>
            </label>
          </div>

          <!-- Packeta-only header (no pickup locations configured) -->
          <div v-else-if="cycle?.parcel_enabled && pickupLocations.length === 0" class="space-y-2">
            <label
              :class="[
                'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                deliveryMethod === 'packeta' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" value="packeta" v-model="deliveryMethod" />
              <div>
                <span class="font-medium">Doručenie Packetou</span>
                <span v-if="cycle?.parcel_fee" class="text-sm text-muted-foreground ml-1">(+{{ formatPrice(cycle.parcel_fee) }})</span>
              </div>
            </label>
            <label
              :class="[
                'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                deliveryMethod === 'pickup' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" value="pickup" v-model="deliveryMethod" />
              <div class="font-medium">Bez doručenia (vyzdvihnem osobne)</div>
            </label>
          </div>

          <!-- Pickup locations section -->
          <div v-if="deliveryMethod === 'pickup' && pickupLocations.length > 0" class="space-y-2 border-t pt-3">
            <label
              v-for="loc in pickupLocations"
              :key="loc.id"
              :class="[
                'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                selectedPickupLocationId === loc.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" :value="loc.id" v-model="selectedPickupLocationId" class="mt-0.5" />
              <div>
                <div class="font-medium">{{ loc.name }}</div>
                <div v-if="loc.address" class="text-sm text-muted-foreground">{{ loc.address }}</div>
              </div>
            </label>
            <!-- "Iné" option -->
            <label
              :class="[
                'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                selectedPickupLocationId === null ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" :value="null" v-model="selectedPickupLocationId" class="mt-0.5" />
              <div class="flex-1">
                <div class="font-medium">Iné</div>
                <input
                  v-if="selectedPickupLocationId === null"
                  v-model="pickupLocationNote"
                  type="text"
                  placeholder="Poznámka (voliteľné)"
                  class="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
            </label>
          </div>

          <!-- Packeta section -->
          <div v-if="deliveryMethod === 'packeta'" class="space-y-3 border-t pt-3">
            <div class="space-y-1">
              <label class="text-sm font-medium">Adresa výdajného miesta *</label>
              <input
                v-model="packetaAddress"
                type="text"
                placeholder="napr. Z-BOX Hlavná 15, Bratislava"
                class="w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>
            <label class="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" v-model="savePacketaAsDefault" class="rounded" />
              Uložiť ako predvolenú adresu
            </label>
          </div>
        </div>
        <DialogFooter class="flex gap-2">
          <Button variant="outline" @click="showPickupModal = false" class="flex-1">
            Zrušiť
          </Button>
          <Button
            @click="confirmPickupAndSubmit"
            class="flex-1"
            :disabled="deliveryMethod === 'packeta' && !packetaAddress.trim()"
          >
            Potvrdiť a odoslať
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
