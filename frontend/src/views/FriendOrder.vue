<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watchEffect, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import api, { getFriendsPassword, getFriendsAuthInfo, getFriendsToken } from '../api'
// shadcn leftovers. `Card`/`CardContent` still dress the product cards (RD-FO-2)
// and the Kolegovia share card (RD-KG-1); `Button` is still used by the product
// steppers (RD-FO-2), the cartbar (RD-FO-3) and every modal (RD-FO-4); `Dialog*`
// is the modals themselves (RD-FO-4). `Alert`, `Badge` and `Tabs*` are gone with
// this row: the banners, the colleague badge and both tab strips are theme
// classes now, and nothing else in this view used them.
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import GuestShareDialog from '@/components/GuestShareDialog.vue'
import GuestSubOrders from '@/components/GuestSubOrders.vue'
import BrandChrome from '@/components/neo/BrandChrome.vue'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import { snapTab } from '@/lib/snap-tab'
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

// Guest share link — all state/logic lives in GuestShareDialog, shared with
// FriendPortal's cycle list so both entry points behave identically.
const showShareModal = ref(false)

// ---- top-level view switch: own order vs colleagues ---------------------------
//
// Everything guest-related used to sit ABOVE the product list, so the host's own
// offer started ~860px down the page and got worse with every colleague who
// ordered. The two jobs — ordering for myself, handing goods to colleagues — now
// live on their own tabs.
//
// ⚠ The panels are v-show, NOT v-if: GuestSubOrders must stay mounted on both tabs
// or its badge count would only appear after the host already opened the tab it is
// meant to advertise. It also keeps the hand-over ticks from re-fetching on every
// switch.
//
// Deliberately NOT persisted and NOT in the URL: a locked cycle opens on 'own' too,
// even though hand-over is the only job left then — the host still wants to see
// what they themselves ordered first (confirmed with the user).
const mainTab = ref('own')

// Fed by GuestSubOrders (one fetch, one owner) — see its `summary` emit.
const guestSummary = ref({ count: 0, total: 0, pendingDelivery: 0, failed: false })

const cycleId = computed(() => route.params.cycleId)

const isLocked = computed(() => cycle.value?.status === 'planned' || cycle.value?.status === 'locked' || cycle.value?.status === 'completed')
const isSubmitted = computed(() => order.value?.status === 'submitted')
const markupRatio = computed(() => cycle.value?.markup_ratio || 1.0)
const isBakery = computed(() => cycle.value?.type === 'bakery')

// Amber (`.tabbadge.pending`) only when the host actually owes someone an action:
// the cycle is locked, so the goods have arrived, and somebody has not been handed
// theirs yet. The plain white/ink `.tabbadge` with the colleague count is the
// resting state; no badge at all when nobody has ordered.
// (Declared after isLocked so the dependency reads in source order.)
//
// ⚠ These two computeds are OWNED BY THIS VIEW and are never re-derived in the
// Kolegovia panel (module 05): the badge must be right before its tab is opened,
// which is only possible from the parent, off `GuestSubOrders`' `summary` emit.
// The prototype always renders the amber pending badge, even on an open cycle
// (04 resolved conflict #1) — shipped semantics win, prototype visuals win.
const guestBadgeIsPending = computed(
  () => isLocked.value && guestSummary.value.pendingDelivery > 0
)
const guestBadgeCount = computed(
  () => guestBadgeIsPending.value ? guestSummary.value.pendingDelivery : guestSummary.value.count
)

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

// The cards of the ACTIVE purpose only — one list, rendered under the strip.
//
// This replaces the radix `TabsContent` panels AND the "only one purpose, so no
// strip" fallback, which were two byte-divergent copies of the same card markup
// (the fallback's had no roast/roastery badges and no `canIncrement` guard on
// "+", so a single-purpose cycle could be stepped past its stock limit in the UI).
// Same one-visible-at-a-time behaviour, one card to restyle in RD-FO-2.
const activeProducts = computed(() => {
  const source = isBakery.value ? groupedBakeryProducts.value : groupedProducts.value
  return source[activeTab.value] || []
})

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

  // Always pre-fill Packeta address from profile (used when user switches to Packeta)
  savePacketaAsDefault.value = false

  // Pre-select based on existing order state
  if (order.value?.packeta_address) {
    deliveryMethod.value = 'packeta'
    packetaAddress.value = order.value.packeta_address
  } else if (order.value?.pickup_location_id) {
    deliveryMethod.value = 'pickup'
    selectedPickupLocationId.value = order.value.pickup_location_id
    pickupLocationNote.value = ''
    packetaAddress.value = friend.value?.packeta_address || ''
  } else if (order.value?.pickup_location_note) {
    deliveryMethod.value = 'pickup'
    selectedPickupLocationId.value = null
    pickupLocationNote.value = order.value.pickup_location_note
    packetaAddress.value = friend.value?.packeta_address || ''
  } else {
    // Default: pickup if locations exist, otherwise packeta
    deliveryMethod.value = hasPickupLocations ? 'pickup' : 'packeta'
    selectedPickupLocationId.value = null
    pickupLocationNote.value = ''
    packetaAddress.value = friend.value?.packeta_address || ''
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
  <!-- ⚠ `.app` brings `.app > * { position:relative; z-index:1 }` with it, which
       NEUTRALISES every Tailwind positioning utility on a DIRECT child — `fixed`,
       `absolute`, `sticky`, and even `relative z-10` (whose z-index is silently
       clamped). It fails silently: no build error, no failing spec. Two live
       consequences on this screen, both handled here:
         · the old `<header … sticky top-0 z-40>` was a direct child and would have
           un-stuck the moment this class landed — it is GONE, replaced by the
           deliberately non-sticky `BrandChrome` (UC-DS-005/006);
         · the purpose strip's old `top-16` was calibrated against that sticky
           header. `.cat-tabs` is `top:0` from the theme, which is now correct
           because nothing above it is pinned any more.
       The cart footer's `fixed bottom-0 z-50` is NESTED (inside the page column),
       so it survives — do not hoist it to root level while it is still on Tailwind
       utilities. RD-FO-3 puts it on `.cartbar`.

       `flex flex-col` + the theme's `min-height:100vh` is the prototype's root
       layout, and it is what lets the page column take `flex-1`. -->
  <div class="app flex flex-col">
    <!-- Brand chrome (UC-FO-001): appbar + hazard tape + ticker, full-bleed, NOT
         sticky — it scrolls away and `.cat-tabs` owns the top edge alone.

         Subtitle is the friend's NAME ONLY. The prototype's appbar shows
         "Lego · X42KPGZZ", but `GET /orders/cycle/:id/friend/:id` returns only
         `{id, name, packeta_address}`, `friends.js` strips `invite_code` from every
         friend response, and no API change is in scope. The session's uid — which
         module 03's portal appbar uses — is OPTIONAL in the stored auth shape, so
         sourcing it here would render "name · code" for some friends and a bare
         name for others. Consistency wins (orchestrator decision, 2026-08-08).

         The back chevron carries the house zero-pixel ARIA layer (role + tabindex
         + Enter/Space): it is a bare `<span>` in the prototype, and it is the only
         in-page route back to the cycle list — the control it replaced was a real
         `<button>`, so leaving it pointer-only would be a regression. Its label is
         "Späť", NOT "Späť na zoznam cyklov": the fatal-error state renders a button
         with that exact text, and Playwright matches accessible names as a
         case-insensitive SUBSTRING unless `exact: true`. -->
    <BrandChrome
      :title="cycle?.name || ''"
      :subtitle="friend?.name || ''"
      :ticker="isLocked
        ? '+++ OBJEDNÁVKY UZAMKNUTÉ +++ DRŽ JAZYK ZA ZUBAMI +++'
        : '+++ OBJEDNÁVKY OTVORENÉ +++ NEHOVOR O TOM NAHLAS +++'"
    >
      <template #leading>
        <span
          class="back"
          role="button"
          tabindex="0"
          aria-label="Späť"
          @click="goBack"
          @keydown.enter.prevent="goBack"
          @keydown.space.prevent="goBack"
        >
          <NeoIcon name="back" />
        </span>
      </template>
      <template #trailing>
        <span v-if="isLocked" class="chip" title="Objednávky sú uzamknuté">
          <NeoIcon name="lock" />
        </span>
        <span v-else class="chip acc">Otvorené</span>
      </template>
    </BrandChrome>

    <!-- Loading -->
    <div v-if="loading" class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7">
      <div class="sub" style="text-align:center;padding:32px 0">Načítavam...</div>
    </div>

    <!-- Fatal error (no friend loaded at all) -->
    <div v-else-if="error && !friend" class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7 flex flex-col gap-[14px]">
      <div class="banner danger" role="alert">
        <span class="dot"></span>
        <div style="min-width:0"><b>Chyba:</b> {{ error }}</div>
      </div>
      <div>
        <button type="button" class="btn" @click="goBack">Späť na zoznam cyklov</button>
      </div>
    </div>

    <!-- Order Form.
         The page column is the settled geometry (UC-DS-005): 760px max, centred,
         16px phone / 28px desktop — written as axis utilities, the same idiom as
         `FriendPortalSession.vue`'s column. `pb-2` is repeated at both breakpoints
         so the `sm` layer cannot re-raise it; that 8px bottom is the prototype's
         `paddingBottom: 8` (UC-FO-001 item 3).

         NOTE: the "never use the `p-4` shorthand" rule that guards the portal's
         column does NOT apply on this route. It exists because
         `guest-link.spec.js`'s `cardFor()` locator (`div.p-4` containing a cycle
         heading) would otherwise match the column as well as the cycle card — and
         that locator only ever runs after `page.goto('/')`, i.e. on the PORTAL.
         It is documented where it belongs, in `FriendPortalSession.vue`. Here
         `p-4` would be perfectly legal (UC-DS-004 rule 2 lists it as an allowed
         layout utility); the axis form is kept for consistency, not for a pin. -->
    <div v-else class="mx-auto w-full max-w-[760px] px-4 sm:px-7 py-4 sm:py-7 pb-2 sm:pb-2 flex flex-col gap-[14px] flex-1">
      <!-- Status banner. Exactly one of the two, in the shipped priority order.
           ⚠ The green one now YIELDS while unsent changes exist — the prototype's
           `submitted && !dirty && lines > 0`, whose repo equivalent is
           `hasUnsubmittedChanges`. The cartbar warning carries that state instead
           (RD-FO-3). A handoff UX change, in contract (UC-FO-002). -->
      <div v-if="isLocked" class="banner warn">
        <span class="dot"></span>
        <div style="min-width:0"><b>Objednávky sú uzamknuté.</b> Už nie je možné meniť objednávku.</div>
      </div>
      <div v-else-if="isSubmitted && cartItems.length > 0 && !hasUnsubmittedChanges" class="banner ok">
        <span class="dot"></span>
        <div style="min-width:0"><b>Vaša objednávka bola odoslaná!</b> Stále ju môžete upraviť až do uzamknutia.</div>
      </div>

      <!-- Messages. Page-level, so they sit ABOVE the switch: the order can be
           submitted from the sticky footer on either tab, and a failure the host
           cannot see because they happen to be on the colleagues tab is worse than
           no message at all. -->
      <div v-if="error" class="banner danger slim" role="alert">
        <span class="dot"></span>
        <div style="min-width:0">{{ error }}</div>
      </div>
      <!-- ⚠ `successMessage` is REACHABLE — but it has no user-initiated trigger
           and one state where it actively misleads. Verified live, not reasoned:

             · `saveCart(false)` is the only writer, and `doSubmitOrder()` is its
               only non-silent caller (the other two — auto-save and cancel — pass
               `silent: true` deliberately). So "Košík bol uložený" only ever
               appears as a side effect of SUBMITTING.
             · After a SUCCESSFUL submit it is in the DOM and laid out, next to
               the green status banner — merely occluded by the success modal,
               and closing that modal navigates away.
             · ⚠ After a FAILED submit it is VISIBLE: `saveCart` has already set
               it, the catch then sets `error`, and the page renders "Košík bol
               uložený" and the failure SIDE BY SIDE for the 3s until the timeout
               fires. Reproduced by stubbing the submit endpoint to 500.

           Identical in the pre-redesign view, so this row introduced none of it.
           RD-FO-3 owns the cartbar and its messaging: either retire this banner
           (nothing calls `saveCart(false)` except the submit) or clear
           `successMessage` at the top of `doSubmitOrder()`'s try. Do not "fix" it
           by giving it a trigger — there is no user-initiated save to report. -->
      <div v-if="successMessage" class="banner ok slim">
        <span class="dot"></span>
        <div style="min-width:0">{{ successMessage }}</div>
      </div>

      <!-- Own order ⇄ colleagues. Hand-rolled rather than the Tabs component
           because the panels must stay MOUNTED (v-show) — see mainTab's note — and
           because only the purpose tabs inside may be sticky: two stacked sticky
           bars eat a third of a phone screen.

           ⚠ This must remain the FIRST tablist in the DOM: `mobile-no-h-overflow`
           asserts `scrollWidth − clientWidth <= 0` on `getByRole('tablist').first()`.
           `.tabgroup` is a 1fr/1fr grid with NO scroll affordance, so an
           overflowing label would simply be unreachable.

           ⚠ The fit model is `min₁ + min₂ + gap ≤ content`, NOT "does the label
           fit a half cell". `grid-auto-columns: 1fr` is `minmax(auto, 1fr)`, so
           each track FLOORS at its own min-content and only the surplus is
           shared: "Moja objednávka" legitimately exceeds half the row (136.2px
           against a 133.5px half cell) and the Kolegovia track gives the
           difference back, down to its own min-content.

           And the binding factor is the BADGE — data-dependent width — not the
           label. Measured at 320px (container content box 272px, gap 5px):

             no badge, Figtree ............. 41.3px headroom
             no badge, fallback face ....... 32.5px
             1-digit badge, Figtree ........ 12.3px      ← the shipped state
             1-digit badge, fallback ....... 3.6px
             3-digit badge, fallback ....... overflows by 2px

           So no override is shipped, but the margin is thin and it is the badge
           that spends it. `order-shell.spec.js`'s 320px test renders a real guest
           sub-order and asserts that headroom stays positive — before RD-FO-1's
           review neither it nor `mobile-no-h-overflow.spec.js` had a badge on
           screen at 320px at all, so the tight case was untested.

           If an override is ever needed it goes on `.tabgroup .tab` ONLY, never on
           `.tab` globally (the purpose strip must keep its canon metrics) — and it
           cannot be a Tailwind utility: `.tabgroup .tab` is `(0,2,0)` and
           `friends-theme.css` loads after Tailwind, so it needs a scoped block. -->
      <div class="tabgroup" role="tablist" aria-label="Objednávka alebo kolegovia">
        <span
          class="tab"
          :class="{ on: mainTab === 'own' }"
          role="tab"
          id="tab-own"
          tabindex="0"
          aria-controls="panel-own"
          :aria-selected="mainTab === 'own' ? 'true' : 'false'"
          data-testid="main-tab-own"
          @click="mainTab = 'own'"
          @keydown.enter.prevent="mainTab = 'own'"
          @keydown.space.prevent="mainTab = 'own'"
        >Moja objednávka</span>
        <span
          class="tab"
          :class="{ on: mainTab === 'guests' }"
          role="tab"
          id="tab-guests"
          tabindex="0"
          aria-controls="panel-guests"
          :aria-selected="mainTab === 'guests' ? 'true' : 'false'"
          data-testid="main-tab-guests"
          @click="mainTab = 'guests'"
          @keydown.enter.prevent="mainTab = 'guests'"
          @keydown.space.prevent="mainTab = 'guests'"
        >
          Kolegovia
          <span
            v-if="guestBadgeCount > 0"
            class="tabbadge"
            :class="{ pending: guestBadgeIsPending }"
            data-testid="guest-tab-badge"
            :title="guestBadgeIsPending
              ? 'Toľkým kolegom ste ešte neodovzdali tovar'
              : 'Toľko kolegov si objednalo cez váš odkaz'"
          >{{ guestBadgeCount }}</span>
        </span>
      </div>

      <!-- ============ panel: colleagues ============ -->
      <div v-show="mainTab === 'guests'" id="panel-guests" role="tabpanel" aria-labelledby="tab-guests">
        <!-- Sharing moved here in full (it used to sit above the product list on
             every load). With colleagues present it is a one-line action; with none
             it IS the panel, so it carries the explanation.

             ⚠ RD-KG-1 restyles this card. What is actually PINNED on it is text,
             not structure — three accessible names / strings that must survive:
               · `Zdieľať objednávku s kolegami` (empty-state button)
                 — guest-link.spec.js:259, guest-host-view.spec.js:945
               · `Zdieľať odkaz` (populated state), matched as /Zdieľať/ when a
                 locked cycle asserts the count is 0 — guest-host-view.spec.js:929
               · `Objednávate aj pre kolegov?` (getByText) — guest-host-view.spec.js:944
             The `p-4` on the CardContent below is NOT pinned by anything (the
             `div.p-4` locator that pins it in the portal never runs on this
             route — see the page column above). -->
        <Card v-if="!isLocked" class="mb-4">
          <CardContent
            v-if="guestSummary.count > 0"
            class="p-4 flex flex-wrap items-center justify-between gap-3"
          >
            <p class="text-xs text-muted-foreground min-w-0">
              Ďalší kolegovia sa môžu pridať cez ten istý odkaz.
            </p>
            <Button variant="outline" size="sm" class="shrink-0 gap-1.5" @click="showShareModal = true">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342A3 3 0 106.316 10.658m0 2.684l8.632 4.316m-8.632-7l8.632-4.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
              Zdieľať odkaz
            </Button>
          </CardContent>

          <!-- Empty state. The tab stays visible with nobody in it precisely so the
               sharing can be found at all — hiding it would bury the feature. -->
          <CardContent v-else class="p-6 flex flex-col items-center gap-2 text-center">
            <span class="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
              Zatiaľ nikto
            </span>
            <div class="font-medium text-sm text-foreground">Objednávate aj pre kolegov?</div>
            <p class="text-xs text-muted-foreground max-w-xs">
              Pošlite im odkaz — objednajú si sami a vy im tovar odovzdáte.
            </p>
            <Button size="sm" class="mt-1 gap-1.5" @click="showShareModal = true">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342A3 3 0 106.316 10.658m0 2.684l8.632 4.316m-8.632-7l8.632-4.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
              Zdieľať objednávku s kolegami
            </Button>
          </CardContent>
        </Card>

        <!-- A locked cycle has no sharing left to offer, but the panel must not be
             empty: the hand-over checklist below is the whole point of it by then. -->
        <p v-else-if="guestSummary.count === 0 && !guestSummary.failed" class="text-sm text-muted-foreground">
          Cez váš odkaz si nikto neobjednal.
        </p>

        <!-- Sub-orders the colleagues placed through the share link. Rendered
             regardless of the lock: removal ends at the lock, but the "odovzdané"
             hand-over checklist is used exactly AFTER it. The guest total inside is
             context only — the host's own payable total below is own items only
             (§UC-GSO-006). -->
        <!-- `ready` waits for an authenticated load: this view restores the friend
             session in onMounted, which runs AFTER a child's setup, so fetching any
             earlier would 401 on a fresh load of /cycle/:id. -->
        <GuestSubOrders
          :cycle-id="cycleId"
          :cycle-locked="isLocked"
          :ready="!!friend"
          @summary="guestSummary = $event"
        />
      </div>

      <!-- ============ panel: own order ============ -->
      <div
        v-show="mainTab === 'own'"
        id="panel-own"
        role="tabpanel"
        aria-labelledby="tab-own"
        class="flex flex-col gap-[14px]"
      >
        <!-- Category strip (UC-FO-004). Purposes are DATA-DERIVED — `availablePurposes`
             is the distinct `product.purpose` of the cycle snapshot, ordered Espresso,
             Filter, Kapsule first and then in encounter order (unchanged shipped rule).
             The prototype's "Filter Special / Brew Bags / Nespresso" are admin-entered
             values, not code.

             ⚠ Geometry comes from `.cat-tabs` in the theme and is NOT re-derived here:
             `position:sticky; top:0; z-index:40`, hidden scrollbar, `scroll-snap-type`,
             the 28px right-edge fade. `top:0` is right ONLY because the chrome above is
             not sticky; the old `top-16` was calibrated against a sticky header that no
             longer exists, and `mobile-no-h-overflow.spec.js` would NOT have caught it.

             `data-testid="purpose-tabs"` moved onto this element and must not be
             dropped, and the tabs must expose `role="tab"` — that spec counts
             `strip.getByRole('tab')`.

             Single purpose ⇒ no strip at all (shipped fallback); the cards below render
             either way. Per-category page tints and coloured triggers are dropped
             (resolved conflict #7): the active tab is `.tab.on` (magenta) and nothing
             else. -->
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

        <!-- Only the active purpose's cards — the same one-visible-at-a-time
             behaviour the radix `TabsContent` panels had. -->
        <div class="flex flex-col gap-4">
          <Card v-for="product in activeProducts" :key="product.id">
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
                  <!-- flex-wrap: the two badges below are `whitespace-nowrap`, so
                       without it a long product name is squeezed to its longest
                       word while the badges push out of the card. GuestProductGrid
                       already wraps here; this keeps the friend view in parity. -->
                  <div class="flex items-center gap-2 flex-wrap">
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
      </div>
      <!-- ============ /panel: own order ============ -->

      <!-- Sticky cart footer. Deliberately OUTSIDE both panels and unchanged: it is
           the host's OWN total, and they must be able to submit without switching
           back. -->
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

    <!-- Share with colleagues (guest link) — shared with FriendPortal -->
    <GuestShareDialog
      :open="showShareModal"
      :cycle-id="cycleId"
      :cycle-name="cycle?.name || ''"
      @update:open="showShareModal = $event"
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
          <div v-if="pickupLocations.length > 0 && cycle?.parcel_enabled" class="space-y-1.5">
            <label
              :class="[
                'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm',
                deliveryMethod === 'pickup' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" value="pickup" v-model="deliveryMethod" />
              <span class="font-medium">Osobný odber</span>
            </label>
            <label
              :class="[
                'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm',
                deliveryMethod === 'packeta' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" value="packeta" v-model="deliveryMethod" />
              <span class="font-medium">Doručenie Packetou</span>
              <span v-if="cycle?.parcel_fee" class="text-muted-foreground">(+{{ formatPrice(cycle.parcel_fee) }})</span>
            </label>
          </div>

          <!-- Packeta-only header (no pickup locations configured) -->
          <div v-else-if="cycle?.parcel_enabled && pickupLocations.length === 0" class="space-y-1.5">
            <label
              :class="[
                'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm',
                deliveryMethod === 'packeta' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" value="packeta" v-model="deliveryMethod" />
              <span class="font-medium">Doručenie Packetou</span>
              <span v-if="cycle?.parcel_fee" class="text-muted-foreground">(+{{ formatPrice(cycle.parcel_fee) }})</span>
            </label>
            <label
              :class="[
                'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm',
                deliveryMethod === 'pickup' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" value="pickup" v-model="deliveryMethod" />
              <span class="font-medium">Bez doručenia (vyzdvihnem osobne)</span>
            </label>
          </div>

          <!-- Pickup locations section -->
          <div v-if="deliveryMethod === 'pickup' && pickupLocations.length > 0" class="space-y-1.5 border-t pt-2">
            <label
              v-for="loc in pickupLocations"
              :key="loc.id"
              :class="[
                'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm',
                selectedPickupLocationId === loc.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" :value="loc.id" v-model="selectedPickupLocationId" />
              <span class="font-medium">{{ loc.name }}</span>
              <span v-if="loc.address" class="text-muted-foreground truncate">{{ loc.address }}</span>
            </label>
            <!-- "Iné" option -->
            <label
              :class="[
                'flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors text-sm',
                selectedPickupLocationId === null ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
              ]"
            >
              <input type="radio" :value="null" v-model="selectedPickupLocationId" class="mt-0.5" />
              <div class="flex-1">
                <span class="font-medium">Iné</span>
                <input
                  v-if="selectedPickupLocationId === null"
                  v-model="pickupLocationNote"
                  type="text"
                  placeholder="Poznámka (voliteľné)"
                  class="mt-1.5 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
